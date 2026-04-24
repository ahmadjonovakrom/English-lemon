from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.security import decode_access_token
from app.models.social import ConversationParticipant, Friendship
from app.models.user import User
from app.services.presence import presence_manager


router = APIRouter(prefix="/presence", tags=["presence"])


class PresencePublic(BaseModel):
    user_id: int
    is_online: bool
    last_seen: datetime | None = None
    in_call: bool = False


class PresenceListResponse(BaseModel):
    users: list[PresencePublic]


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


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


def get_friend_ids(db: Session, user_id: int) -> set[int]:
    rows = db.scalars(
        select(Friendship).where(
            or_(Friendship.user_one_id == user_id, Friendship.user_two_id == user_id)
        )
    ).all()
    friend_ids: set[int] = set()
    for row in rows:
        friend_ids.add(row.user_two_id if row.user_one_id == user_id else row.user_one_id)
    return friend_ids


def get_conversation_peer_ids(db: Session, conversation_id: int, user_id: int) -> set[int]:
    participant_ids = set(
        db.scalars(
            select(ConversationParticipant.user_id).where(
                ConversationParticipant.conversation_id == conversation_id
            )
        ).all()
    )
    if user_id not in participant_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not allowed to send presence events for this conversation.",
        )
    participant_ids.discard(user_id)
    return participant_ids


def to_presence_public(user: User) -> PresencePublic:
    return PresencePublic(
        user_id=user.id,
        is_online=bool(user.is_online),
        last_seen=user.last_seen,
        in_call=bool(user.in_call),
    )


async def broadcast_presence(db: Session, user: User) -> None:
    friend_ids = get_friend_ids(db, user.id)
    payload = {
        "type": "presence_update",
        "presence": to_presence_public(user).model_dump(mode="json"),
    }
    await presence_manager.broadcast_to_users(friend_ids | {user.id}, payload)


@router.get("/users", response_model=PresenceListResponse)
def list_presence(
    ids: str = Query(default="", max_length=1000),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    requested_ids = {
        int(raw_id)
        for raw_id in ids.split(",")
        if raw_id.strip().isdigit()
    }
    allowed_ids = get_friend_ids(db, current_user.id) | {current_user.id}
    target_ids = requested_ids & allowed_ids
    if not target_ids:
        return PresenceListResponse(users=[])
    users = db.scalars(select(User).where(User.id.in_(target_ids))).all()
    return PresenceListResponse(users=[to_presence_public(user) for user in users])


@router.websocket("/ws")
async def presence_websocket(
    websocket: WebSocket,
    db: Session = Depends(get_db),
):
    user = authenticate_websocket_user(websocket, db)
    if not user:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Unauthorized.")
        return

    connection_id = websocket.query_params.get("connection_id") or uuid4().hex
    await websocket.accept()
    tab_count = await presence_manager.connect(user.id, connection_id, websocket)

    user.is_online = True
    user.last_seen = now_utc()
    db.commit()
    db.refresh(user)
    if tab_count == 1:
        await broadcast_presence(db, user)

    await websocket.send_json(
        {
            "type": "ready",
            "presence": to_presence_public(user).model_dump(mode="json"),
        }
    )

    try:
        while True:
            message = await websocket.receive_json()
            message_type = str(message.get("type") or "").strip().lower()
            conversation_id = message.get("conversation_id")

            if message_type == "heartbeat":
                user.last_seen = now_utc()
                db.commit()
                await websocket.send_json({"type": "heartbeat"})
                continue

            if message_type in {
                "typing_start",
                "typing_stop",
                "recording_start",
                "recording_stop",
            }:
                if not isinstance(conversation_id, int):
                    await websocket.send_json(
                        {
                            "type": "error",
                            "message": "conversation_id is required for activity events.",
                        }
                    )
                    continue
                peer_ids = get_conversation_peer_ids(db, conversation_id, user.id)
                await presence_manager.broadcast_to_users(
                    peer_ids,
                    {
                        "type": message_type,
                        "conversation_id": conversation_id,
                        "user_id": user.id,
                    },
                )
                continue

            if message_type == "call_status_update":
                in_call = bool(message.get("in_call"))
                user.in_call = in_call
                user.last_seen = now_utc()
                db.commit()
                db.refresh(user)
                await broadcast_presence(db, user)
                continue

            await websocket.send_json(
                {
                    "type": "error",
                    "message": "Unsupported presence message.",
                }
            )
    except WebSocketDisconnect:
        pass
    finally:
        remaining_tabs = await presence_manager.disconnect(user.id, connection_id)
        if remaining_tabs == 0:
            user.is_online = False
            user.last_seen = now_utc()
            user.in_call = False
            db.commit()
            db.refresh(user)
            await broadcast_presence(db, user)
