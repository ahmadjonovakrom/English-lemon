from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import SessionLocal, get_db
from app.core.security import decode_access_token
from app.models.multiplayer import MultiplayerRoom
from app.models.user import User
from app.schemas.multiplayer import (
    CreateRoomRequest,
    InvitePlayerRequest,
    JoinRoomByCodeRequest,
    MultiplayerActionResponse,
    RoomDetailResponse,
    RoomListResponse,
    RoomResultsPublic,
)
from app.services.multiplayer import (
    ACTIVE_ROOM_STATUSES,
    all_answered_for_current_question,
    build_room_detail_response,
    get_room_or_404,
    get_room_query,
    get_room_current_question,
    invite_friend_to_room,
    join_room,
    leave_room,
    mark_room_completed,
    reveal_current_question,
    room_manager,
    serialize_results,
    serialize_room_summary,
    start_first_question_after_countdown,
    start_room,
    submit_answer,
    update_player_presence,
)


router = APIRouter(prefix="/rooms", tags=["multiplayer"])


def websocket_token(websocket: WebSocket) -> str | None:
    query_token = websocket.query_params.get("token")
    if query_token:
        return query_token
    authorization = websocket.headers.get("authorization")
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


def authenticate_websocket_user(websocket: WebSocket, db: Session) -> User | None:
    token = websocket_token(websocket)
    if not token:
        return None
    try:
        user_id = int(decode_access_token(token))
    except Exception:
        return None
    return db.get(User, user_id)


@router.post("", response_model=RoomDetailResponse, status_code=status.HTTP_201_CREATED)
def create_room_endpoint(
    payload: CreateRoomRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from app.services.multiplayer import create_room

    room = create_room(db, host=current_user, payload=payload)
    return build_room_detail_response(room, current_user.id)


@router.get("", response_model=RoomListResponse)
def list_rooms(
    status_filter: str | None = Query(default=None, alias="status"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    hydrated = (
        db.execute(
            get_room_query()
            .order_by(MultiplayerRoom.created_at.desc(), MultiplayerRoom.id.desc())
            .limit(50)
        )
        .unique()
        .scalars()
        .all()
    )

    normalized_status = str(status_filter or "").strip().lower()
    items = []
    for room in hydrated:
        if normalized_status and room.status.lower() != normalized_status:
            continue
        if not normalized_status and room.status not in ACTIVE_ROOM_STATUSES and room.status != "completed":
            continue
        items.append(serialize_room_summary(room))

    return RoomListResponse(rooms=items)


@router.post("/join-by-code", response_model=RoomDetailResponse)
def join_room_by_code(
    payload: JoinRoomByCodeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    room_code = payload.room_code.strip().upper()
    room = db.scalar(select(MultiplayerRoom).where(MultiplayerRoom.room_code == room_code))
    if not room:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room code was not found.")
    hydrated = get_room_or_404(db, room.id)
    joined = join_room(db, room=hydrated, user=current_user)
    return build_room_detail_response(joined, current_user.id)


@router.get("/{room_id}", response_model=RoomDetailResponse)
def get_room(room_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    room = get_room_or_404(db, room_id)
    return build_room_detail_response(room, current_user.id)


@router.post("/{room_id}/join", response_model=RoomDetailResponse)
def join_room_endpoint(
    room_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    room = get_room_or_404(db, room_id)
    joined = join_room(db, room=room, user=current_user)
    return build_room_detail_response(joined, current_user.id)


@router.post("/{room_id}/leave", response_model=RoomDetailResponse)
def leave_room_endpoint(
    room_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    room = get_room_or_404(db, room_id)
    updated = leave_room(db, room=room, user=current_user)
    room_manager.cancel(room_id) if updated.status == "cancelled" else None
    return build_room_detail_response(updated, current_user.id)


@router.post("/{room_id}/start", response_model=RoomDetailResponse)
def start_room_endpoint(
    room_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    room = get_room_or_404(db, room_id)
    started = start_room(db, room=room, user=current_user)
    room_manager.schedule(room_id, start_first_question_after_countdown(room_id))
    return build_room_detail_response(started, current_user.id)


@router.post("/{room_id}/invite", response_model=MultiplayerActionResponse)
def invite_friend(
    room_id: int,
    payload: InvitePlayerRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    room = get_room_or_404(db, room_id)
    invite_friend_to_room(db, room=room, sender=current_user, friend_user_id=payload.friend_user_id)
    return MultiplayerActionResponse(detail="Friend invited to the room.")


@router.get("/{room_id}/results", response_model=RoomResultsPublic)
def get_room_results(
    room_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    room = get_room_or_404(db, room_id)
    if room.status == "in_progress":
        room = mark_room_completed(db, room)
    return RoomResultsPublic.model_validate(serialize_results(room))


@router.websocket("/ws/{room_id}")
async def room_websocket(room_id: int, websocket: WebSocket):
    with SessionLocal() as db:
        user = authenticate_websocket_user(websocket, db)
        if not user:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Unauthorized.")
            return

        room = get_room_or_404(db, room_id)
        player = next((item for item in room.players if item.user_id == user.id and item.left_at is None), None)
        if not player:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Join the room first.")
            return

    connection_id = websocket.query_params.get("connection_id") or uuid4().hex
    await websocket.accept()
    await room_manager.connect(room_id, user.id, websocket, connection_id)

    with SessionLocal() as db:
        update_player_presence(db, room_id=room_id, user_id=user.id, is_connected=True)

    await room_manager.send_to_room(
        room_id,
        {"type": "player.joined", "room_id": room_id, "user_id": user.id},
    )
    await room_manager.broadcast_snapshot(room_id)

    try:
        while True:
            message = await websocket.receive_json()
            message_type = str(message.get("type") or "").strip().lower()

            if message_type == "heartbeat":
                await websocket.send_json({"type": "heartbeat"})
                continue

            if message_type == "sync":
                await room_manager.broadcast_snapshot(room_id)
                continue

            if message_type == "answer.submit":
                with SessionLocal() as db:
                    room = get_room_or_404(db, room_id)
                    result = submit_answer(
                        db,
                        room=room,
                        user=user,
                        question_id=int(message.get("question_id")),
                        selected_option_index=int(message.get("selected_option_index")),
                    )
                    updated_room = result["room"]
                await room_manager.send_to_room(room_id, result["event"])
                await room_manager.broadcast_snapshot(room_id)

                if all_answered_for_current_question(updated_room):
                    current_question = get_room_current_question(updated_room)
                    if current_question:
                        room_manager.schedule(
                            room_id,
                            reveal_current_question(room_id, current_question.question_index),
                        )
                continue

            await websocket.send_json(
                {"type": "error", "message": "Unsupported room socket message."}
            )
    except WebSocketDisconnect:
        pass
    finally:
        with SessionLocal() as db:
            updated_room = update_player_presence(db, room_id=room_id, user_id=user.id, is_connected=False)
        await room_manager.disconnect(room_id, connection_id)
        await room_manager.send_to_room(
            room_id,
            {"type": "player.left", "room_id": room_id, "user_id": user.id},
        )
        if updated_room:
            await room_manager.broadcast_snapshot(room_id)
