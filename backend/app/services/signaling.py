import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import WebSocket
from starlette.websockets import WebSocketState

from app.schemas.signaling import SignalingMessage


logger = logging.getLogger("uvicorn.error")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def sdp_preview(sdp: str, max_chars: int = 80) -> str:
    return sdp[:max_chars].replace("\r", "\\r").replace("\n", "\\n")


@dataclass
class SignalingConnection:
    room_id: str
    user_id: int
    websocket: WebSocket
    connected_at: datetime


class SignalingConnectionManager:
    def __init__(self, max_participants_per_room: int = 2) -> None:
        self.max_participants_per_room = max_participants_per_room
        self.rooms: dict[str, dict[int, SignalingConnection]] = {}

    async def connect(self, room_id: str, user_id: int, websocket: WebSocket) -> None:
        room = self.rooms.setdefault(room_id, {})
        if user_id not in room and len(room) >= self.max_participants_per_room:
            logger.warning(
                "Signaling room rejected: room=%s user=%s reason=max_participants",
                room_id,
                user_id,
            )
            raise ValueError("Call room is full.")

        previous = room.get(user_id)
        if previous:
            await self.safe_close(previous.websocket, code=4001, reason="Replaced by reconnect.")

        room[user_id] = SignalingConnection(
            room_id=room_id,
            user_id=user_id,
            websocket=websocket,
            connected_at=datetime.now(timezone.utc),
        )
        logger.info(
            "Signaling user joined: room=%s user=%s participants=%s",
            room_id,
            user_id,
            sorted(room.keys()),
        )

    async def disconnect(
        self,
        room_id: str,
        user_id: int,
        *,
        notify_peer: bool = True,
        reason: str = "leave",
    ) -> None:
        room = self.rooms.get(room_id)
        if not room:
            return

        removed = room.pop(user_id, None)
        if removed:
            logger.info(
                "Signaling user left: room=%s user=%s reason=%s participants=%s",
                room_id,
                user_id,
                reason,
                sorted(room.keys()),
            )

        if notify_peer and removed:
            await self.broadcast_to_room(
                room_id,
                {
                    "type": "leave",
                    "roomId": room_id,
                    "fromUserId": str(user_id),
                    "payload": {"reason": reason, "timestamp": now_iso()},
                },
                exclude_user_id=user_id,
            )

        if not room:
            self.rooms.pop(room_id, None)
            logger.info("Signaling room cleaned up: room=%s", room_id)

    async def relay(self, message: SignalingMessage) -> bool:
        if message.type in {"offer", "answer"} and message.sdp:
            logger.info(
                "Signaling relay %s: room=%s from=%s to=%s sdp_len=%s sdp_start=%s",
                message.type,
                message.roomId,
                message.fromUserId,
                message.toUserId,
                len(message.sdp.sdp),
                sdp_preview(message.sdp.sdp),
            )
        elif message.type == "candidate" and message.candidate:
            logger.info(
                "Signaling relay candidate: room=%s from=%s to=%s candidate_start=%s",
                message.roomId,
                message.fromUserId,
                message.toUserId,
                message.candidate.candidate[:80],
            )
        else:
            logger.info(
                "Signaling relay %s: room=%s from=%s to=%s",
                message.type,
                message.roomId,
                message.fromUserId,
                message.toUserId,
            )

        if message.toUserId:
            return await self.send_to_user(
                message.roomId,
                int(message.toUserId),
                message.model_dump(exclude_none=True),
            )
        await self.broadcast_to_room(
            message.roomId,
            message.model_dump(exclude_none=True),
            exclude_user_id=int(message.fromUserId),
        )
        return True

    async def send_to_user(self, room_id: str, user_id: int, payload: dict) -> bool:
        room = self.rooms.get(room_id)
        connection = room.get(user_id) if room else None
        if not connection:
            logger.info(
                "Signaling target unavailable: room=%s to=%s type=%s",
                room_id,
                user_id,
                payload.get("type"),
            )
            return False

        try:
            await connection.websocket.send_json(payload)
            return True
        except Exception as exc:
            logger.warning(
                "Signaling send failed: room=%s to=%s error=%s",
                room_id,
                user_id,
                exc,
            )
            await self.disconnect(room_id, user_id, notify_peer=True, reason="send_failed")
            return False

    async def broadcast_to_room(
        self,
        room_id: str,
        payload: dict,
        *,
        exclude_user_id: int | None = None,
    ) -> None:
        room = list((self.rooms.get(room_id) or {}).values())
        for connection in room:
            if exclude_user_id is not None and connection.user_id == exclude_user_id:
                continue
            await self.send_to_user(room_id, connection.user_id, payload)

    async def safe_close(self, websocket: WebSocket, code: int = 1000, reason: str = "") -> None:
        try:
            if websocket.application_state != WebSocketState.DISCONNECTED:
                await websocket.close(code=code, reason=reason)
        except Exception:
            pass


signaling_manager = SignalingConnectionManager()
