import json
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.security import decode_access_token
from app.models.social import Notification
from app.models.user import User
from app.schemas.notifications import (
    NotificationActionResponse,
    NotificationItem,
    NotificationListResponse,
    NotificationUnreadCountResponse,
)
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


def parse_metadata(payload: str | None) -> dict | None:
    if not payload:
        return None
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else {"value": parsed}


def related_entity_fields(notification: Notification) -> tuple[int | None, str | None]:
    if notification.related_challenge_id:
        return notification.related_challenge_id, "challenge"
    if notification.related_conversation_id:
        return notification.related_conversation_id, "conversation"
    if notification.related_user_id:
        return notification.related_user_id, "user"
    return None, None


def to_notification_item(notification: Notification) -> NotificationItem:
    related_entity_id, related_entity_type = related_entity_fields(notification)
    return NotificationItem(
        id=notification.id,
        type=notification.type,
        title=notification.title,
        message=notification.body,
        is_read=notification.is_read,
        created_at=notification.created_at,
        related_user_id=notification.related_user_id,
        related_entity_id=related_entity_id,
        related_entity_type=related_entity_type,
        metadata=parse_metadata(notification.metadata_json),
    )


def unread_count(db: Session, user_id: int) -> int:
    return int(
        db.scalar(
            select(func.count(Notification.id)).where(
                Notification.user_id == user_id, Notification.is_read.is_(False)
            )
        )
        or 0
    )


@router.get("", response_model=NotificationListResponse)
def list_notifications(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(Notification)
        .where(Notification.user_id == current_user.id)
        .order_by(Notification.created_at.desc(), Notification.id.desc())
        .limit(60)
    ).all()
    return NotificationListResponse(
        notifications=[to_notification_item(row) for row in rows],
        unread_count=unread_count(db, current_user.id),
    )


@router.get("/unread-count", response_model=NotificationUnreadCountResponse)
def get_unread_count(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return NotificationUnreadCountResponse(unread_count=unread_count(db, current_user.id))


@router.patch("/{notification_id}/read", response_model=NotificationActionResponse)
def mark_notification_read(
    notification_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    notification = db.get(Notification, notification_id)
    if not notification or notification.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found.")

    if not notification.is_read:
        notification.is_read = True
        db.commit()
    return NotificationActionResponse(detail="Notification marked as read.")


@router.patch("/read-all", response_model=NotificationActionResponse)
def mark_all_notifications_read(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    db.execute(
        update(Notification)
        .where(Notification.user_id == current_user.id, Notification.is_read.is_(False))
        .values(is_read=True)
    )
    db.commit()
    return NotificationActionResponse(detail="All notifications marked as read.")


@router.delete("/{notification_id}", response_model=NotificationActionResponse)
def delete_notification(
    notification_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    notification = db.get(Notification, notification_id)
    if not notification or notification.user_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found.")
    db.delete(notification)
    db.commit()
    return NotificationActionResponse(detail="Notification deleted.")


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
                await websocket.send_json(
                    {"type": "sync_ack", "unread_count": unread_count(db, user.id)}
                )
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
