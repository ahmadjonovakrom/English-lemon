import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import WebSocket
from starlette.websockets import WebSocketState


logger = logging.getLogger("uvicorn.error")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class NotificationConnection:
    user_id: int
    websocket: WebSocket
    connected_at: datetime
    connection_id: str


class NotificationConnectionManager:
    def __init__(self) -> None:
        self.connections: dict[int, dict[str, NotificationConnection]] = {}

    async def connect(self, user_id: int, websocket: WebSocket, connection_id: str) -> None:
        user_connections = self.connections.setdefault(user_id, {})
        previous = user_connections.get(connection_id)
        if previous:
            await self.safe_close(previous.websocket, code=4001, reason="Replaced by reconnect.")

        user_connections[connection_id] = NotificationConnection(
            user_id=user_id,
            websocket=websocket,
            connected_at=datetime.now(timezone.utc),
            connection_id=connection_id,
        )
        logger.info(
            "Notification socket connected: user=%s tabs=%s",
            user_id,
            len(user_connections),
        )

    async def disconnect(self, user_id: int, connection_id: str) -> None:
        user_connections = self.connections.get(user_id)
        if not user_connections:
            return

        user_connections.pop(connection_id, None)
        if user_connections:
            logger.info(
                "Notification socket disconnected: user=%s tabs=%s",
                user_id,
                len(user_connections),
            )
            return

        self.connections.pop(user_id, None)
        logger.info("Notification socket user offline: user=%s", user_id)

    async def send_to_user(self, user_id: int, payload: dict) -> bool:
        user_connections = list((self.connections.get(user_id) or {}).values())
        if not user_connections:
            return False

        delivered = False
        for connection in user_connections:
            try:
                await connection.websocket.send_json(payload)
                delivered = True
            except Exception as exc:
                logger.warning(
                    "Notification socket send failed: user=%s connection=%s error=%s",
                    user_id,
                    connection.connection_id,
                    exc,
                )
                await self.disconnect(user_id, connection.connection_id)
        return delivered

    async def send_notification(
        self,
        *,
        user_id: int,
        notification: dict,
        unread_count: int | None = None,
    ) -> bool:
        payload = {
            "type": "notification",
            "notification": notification,
            "unread_count": unread_count,
            "sent_at": now_iso(),
        }
        return await self.send_to_user(user_id, payload)

    async def send_unread_count(self, *, user_id: int, unread_count: int) -> bool:
        return await self.send_to_user(
            user_id,
            {
                "type": "unread_count",
                "unread_count": unread_count,
                "sent_at": now_iso(),
            },
        )

    async def safe_close(self, websocket: WebSocket, code: int = 1000, reason: str = "") -> None:
        try:
            if websocket.application_state != WebSocketState.DISCONNECTED:
                await websocket.close(code=code, reason=reason)
        except Exception:
            pass


notification_manager = NotificationConnectionManager()
