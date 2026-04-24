from uuid import uuid4

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, status
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import decode_access_token
from app.models.user import User
from app.services.notifications import notification_manager


router = APIRouter(prefix="/notifications", tags=["notifications"])


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


@router.websocket("/ws")
async def notifications_websocket(
    websocket: WebSocket,
    db: Session = Depends(get_db),
):
    user = authenticate_websocket_user(websocket, db)
    if not user:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="Unauthorized.")
        return

    connection_id = websocket.query_params.get("connection_id") or uuid4().hex
    await websocket.accept()
    await notification_manager.connect(user.id, websocket, connection_id)
    await websocket.send_json(
        {
            "type": "ready",
            "connection_id": connection_id,
            "user_id": user.id,
        }
    )

    try:
        while True:
            message = await websocket.receive_json()
            message_type = str(message.get("type") or "").strip().lower()
            if message_type == "heartbeat":
                await websocket.send_json({"type": "heartbeat"})
            elif message_type == "sync":
                await websocket.send_json({"type": "sync_ack"})
            else:
                await websocket.send_json(
                    {
                        "type": "error",
                        "code": "unsupported_message",
                        "message": "Unsupported notification socket message.",
                    }
                )
    except WebSocketDisconnect:
        pass
    finally:
        await notification_manager.disconnect(user.id, connection_id)
