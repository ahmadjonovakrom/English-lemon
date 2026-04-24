import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import WebSocket
from starlette.websockets import WebSocketState


logger = logging.getLogger("uvicorn.error")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class PresenceConnection:
    user_id: int
    connection_id: str
    websocket: WebSocket
    connected_at: datetime


class PresenceConnectionManager:
    def __init__(self) -> None:
        self.connections: dict[int, dict[str, PresenceConnection]] = {}

    async def connect(self, user_id: int, connection_id: str, websocket: WebSocket) -> int:
        user_connections = self.connections.setdefault(user_id, {})
        previous = user_connections.get(connection_id)
        if previous:
            await self.safe_close(previous.websocket, code=4001, reason="Replaced by reconnect.")

        user_connections[connection_id] = PresenceConnection(
            user_id=user_id,
            connection_id=connection_id,
            websocket=websocket,
            connected_at=datetime.now(timezone.utc),
        )
        logger.info("Presence connected: user=%s tabs=%s", user_id, len(user_connections))
        return len(user_connections)

    async def disconnect(self, user_id: int, connection_id: str) -> int:
        user_connections = self.connections.get(user_id)
        if not user_connections:
            return 0
        user_connections.pop(connection_id, None)
        remaining = len(user_connections)
        if remaining == 0:
            self.connections.pop(user_id, None)
        logger.info("Presence disconnected: user=%s tabs=%s", user_id, remaining)
        return remaining

    def is_online(self, user_id: int) -> bool:
        return bool(self.connections.get(user_id))

    async def send_to_user(self, user_id: int, payload: dict) -> bool:
        connections = list((self.connections.get(user_id) or {}).values())
        if not connections:
            return False
        delivered = False
        for connection in connections:
            try:
                await connection.websocket.send_json(payload)
                delivered = True
            except Exception as exc:
                logger.warning(
                    "Presence send failed: user=%s connection=%s error=%s",
                    user_id,
                    connection.connection_id,
                    exc,
                )
                await self.disconnect(user_id, connection.connection_id)
        return delivered

    async def broadcast_to_users(self, user_ids: set[int], payload: dict) -> None:
        for user_id in user_ids:
            await self.send_to_user(user_id, payload)

    async def safe_close(self, websocket: WebSocket, code: int = 1000, reason: str = "") -> None:
        try:
            if websocket.application_state != WebSocketState.DISCONNECTED:
                await websocket.close(code=code, reason=reason)
        except Exception:
            pass


presence_manager = PresenceConnectionManager()
