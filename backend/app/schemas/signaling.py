from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


SignalingMessageType = Literal[
    "join",
    "offer",
    "answer",
    "candidate",
    "ringing",
    "ready",
    "leave",
    "end_call",
    "heartbeat",
    "error",
]


class SessionDescriptionPayload(BaseModel):
    type: Literal["offer", "answer"]
    sdp: str = Field(min_length=10, max_length=120000)

    @field_validator("sdp")
    @classmethod
    def validate_full_sdp(cls, value: str) -> str:
        if not value.startswith("v=0"):
            raise ValueError("SDP must start with v=0.")
        lines = [line.strip() for line in value.splitlines() if line.strip()]
        if len(lines) < 5:
            raise ValueError("SDP is incomplete.")
        if lines[0].startswith("a=") or lines[0].startswith("candidate:"):
            raise ValueError("SDP cannot be an ICE candidate or SDP fragment.")
        required_prefixes = ("o=", "s=", "t=", "m=")
        for prefix in required_prefixes:
            if not any(line.startswith(prefix) for line in lines):
                raise ValueError(f"SDP missing {prefix} line.")
        return value


class IceCandidatePayload(BaseModel):
    candidate: str = Field(min_length=1, max_length=12000)
    sdpMid: str | None = Field(default=None, max_length=40)
    sdpMLineIndex: int | None = Field(default=None, ge=0, le=128)
    usernameFragment: str | None = Field(default=None, max_length=256)

    @field_validator("candidate")
    @classmethod
    def validate_candidate(cls, value: str) -> str:
        normalized = value.strip()
        if normalized.startswith("a=candidate:"):
            normalized = normalized[2:]
        if not normalized.startswith("candidate:"):
            raise ValueError("ICE candidate must start with candidate:.")
        if normalized.startswith("v=0") or "\nm=" in normalized or "\r\nm=" in normalized:
            raise ValueError("ICE candidate cannot contain SDP.")
        return normalized


class SignalingMessage(BaseModel):
    type: SignalingMessageType
    roomId: str = Field(min_length=1, max_length=120)
    fromUserId: str = Field(min_length=1, max_length=80)
    toUserId: str | None = Field(default=None, max_length=80)
    sdp: SessionDescriptionPayload | None = None
    candidate: IceCandidatePayload | None = None
    payload: dict[str, Any] | None = None

    model_config = ConfigDict(extra="forbid")

    @field_validator("roomId")
    @classmethod
    def validate_room_id(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("roomId is required.")
        if any(char.isspace() for char in normalized):
            raise ValueError("roomId cannot contain whitespace.")
        return normalized

    @field_validator("fromUserId", "toUserId")
    @classmethod
    def normalize_user_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("user id cannot be empty.")
        return normalized


class ErrorMessage(BaseModel):
    type: Literal["error"] = "error"
    roomId: str | None = None
    message: str
    code: str = "invalid_message"


def validate_signaling_contract(message: SignalingMessage) -> None:
    if message.type in {"offer", "answer"}:
        if message.sdp is None:
            raise ValueError(f"{message.type} message requires sdp.")
        if message.sdp.type != message.type:
            raise ValueError(f"{message.type} message sdp.type must be {message.type}.")
        if message.candidate is not None:
            raise ValueError(f"{message.type} message cannot include candidate.")
        if not message.toUserId:
            raise ValueError(f"{message.type} message requires toUserId.")
    elif message.type == "candidate":
        if message.candidate is None:
            raise ValueError("candidate message requires candidate.")
        if message.sdp is not None:
            raise ValueError("candidate message cannot include sdp.")
        if not message.toUserId:
            raise ValueError("candidate message requires toUserId.")
    elif message.type in {"ringing", "ready", "leave", "end_call"}:
        if not message.toUserId:
            raise ValueError(f"{message.type} message requires toUserId.")
