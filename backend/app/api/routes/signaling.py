import logging

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, status
from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import decode_access_token
from app.models.user import User
from app.schemas.signaling import ErrorMessage, SignalingMessage, validate_signaling_contract
from app.services.signaling import signaling_manager


router = APIRouter(prefix="/signaling", tags=["signaling"])
logger = logging.getLogger("uvicorn.error")


def websocket_token(websocket: WebSocket) -> str | None:
    query_token = websocket.query_params.get("token")
    if query_token:
        return query_token

    authorization = websocket.headers.get("authorization")
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()

    protocol = websocket.headers.get("sec-websocket-protocol")
    if protocol:
        for part in protocol.split(","):
            candidate = part.strip()
            if candidate.lower().startswith("bearer."):
                return candidate[7:].strip()
            if candidate.lower().startswith("token."):
                return candidate[6:].strip()
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


async def send_error(
    websocket: WebSocket,
    *,
    room_id: str | None,
    message: str,
    code: str = "invalid_message",
) -> None:
    await websocket.send_json(
        ErrorMessage(roomId=room_id, message=message, code=code).model_dump(exclude_none=True)
    )


def validate_user_identity(message: SignalingMessage, current_user_id: int) -> None:
    if message.fromUserId != str(current_user_id):
        raise ValueError("fromUserId does not match authenticated socket user.")
    if message.toUserId is not None:
        try:
            int(message.toUserId)
        except ValueError as exc:
            raise ValueError("toUserId must be numeric.") from exc


@router.websocket("/ws/{room_id}")
async def signaling_websocket(
    websocket: WebSocket,
    room_id: str,
    db: Session = Depends(get_db),
):
    user = authenticate_websocket_user(websocket, db)
    if not user:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Unauthorized.")
        return

    normalized_room_id = room_id.strip()
    if not normalized_room_id or any(char.isspace() for char in normalized_room_id):
        await websocket.close(
            code=status.WS_1008_POLICY_VIOLATION,
            reason="Invalid room id.",
        )
        return

    await websocket.accept()
    try:
        await signaling_manager.connect(normalized_room_id, user.id, websocket)
    except ValueError as exc:
        logger.warning(
            "Signaling join rejected: room=%s user=%s error=%s",
            normalized_room_id,
            user.id,
            exc,
        )
        await send_error(
            websocket,
            room_id=normalized_room_id,
            message=str(exc),
            code="room_full",
        )
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason=str(exc))
        return

    await websocket.send_json(
        {
            "type": "ready",
            "roomId": normalized_room_id,
            "fromUserId": "server",
            "toUserId": str(user.id),
            "payload": {"userId": str(user.id)},
        }
    )

    try:
        while True:
            try:
                raw_message = await websocket.receive_json()
            except ValueError:
                logger.warning(
                    "Signaling invalid JSON: room=%s user=%s",
                    normalized_room_id,
                    user.id,
                )
                await send_error(
                    websocket,
                    room_id=normalized_room_id,
                    message="Message must be valid JSON.",
                    code="invalid_json",
                )
                continue

            try:
                message = SignalingMessage.model_validate(raw_message)
                if message.roomId != normalized_room_id:
                    raise ValueError("Message roomId does not match socket room.")
                validate_user_identity(message, user.id)
                validate_signaling_contract(message)
            except (ValidationError, ValueError) as exc:
                logger.warning(
                    "Signaling payload rejected: room=%s user=%s error=%s payload=%s",
                    normalized_room_id,
                    user.id,
                    exc,
                    raw_message,
                )
                await send_error(
                    websocket,
                    room_id=normalized_room_id,
                    message=str(exc),
                    code="invalid_payload",
                )
                continue

            if message.type == "join":
                logger.info("Signaling join acknowledged: room=%s user=%s", room_id, user.id)
                await websocket.send_json(
                    {
                        "type": "ready",
                        "roomId": normalized_room_id,
                        "fromUserId": "server",
                        "toUserId": str(user.id),
                    }
                )
                continue

            if message.type == "heartbeat":
                await websocket.send_json(
                    {
                        "type": "heartbeat",
                        "roomId": normalized_room_id,
                        "fromUserId": "server",
                        "toUserId": str(user.id),
                    }
                )
                continue

            if message.type in {"leave", "end_call"}:
                await signaling_manager.relay(message)
                await signaling_manager.disconnect(
                    normalized_room_id,
                    user.id,
                    notify_peer=False,
                    reason=message.type,
                )
                if message.type == "leave":
                    await websocket.close(code=status.WS_1000_NORMAL_CLOSURE)
                    return
                continue

            delivered = await signaling_manager.relay(message)
            if not delivered:
                await send_error(
                    websocket,
                    room_id=normalized_room_id,
                    message="Peer is not connected to this call room.",
                    code="peer_unavailable",
                )

    except WebSocketDisconnect:
        logger.warning(
            "Signaling unexpected disconnect: room=%s user=%s",
            normalized_room_id,
            user.id,
        )
    finally:
        await signaling_manager.disconnect(
            normalized_room_id,
            user.id,
            notify_peer=True,
            reason="disconnect",
        )
