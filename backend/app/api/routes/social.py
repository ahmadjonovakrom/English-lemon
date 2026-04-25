import json
import logging
from anyio import from_thread
from datetime import datetime, timedelta, timezone
from functools import partial
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy import and_, case, func, or_, select, update
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.social import (
    CallSession,
    Challenge,
    Conversation,
    ConversationParticipant,
    FriendRequest,
    Friendship,
    Message,
    Notification,
    VoiceMessage,
)
from app.models.user import User
from app.services.notifications import notification_manager
from app.schemas.social import (
    ActionResponse,
    CallAcceptRequest,
    CallCreateRequest,
    CallIceCandidateRequest,
    CallPublic,
    ChallengeCreateRequest,
    ChallengePublic,
    ChallengeStartResponse,
    ChallengeSubmitRequest,
    ChallengeSubmitResponse,
    ConversationCreateRequest,
    ConversationListResponse,
    ConversationMessagesResponse,
    ConversationPublic,
    ConversationTimelineItem,
    FriendRequestCreate,
    FriendRequestPublic,
    FriendRequestsBundle,
    FriendshipPublic,
    MarkAllReadResponse,
    MarkSeenResponse,
    MessagePreview,
    MessagePublic,
    MessageSendRequest,
    NotificationListResponse,
    NotificationPublic,
    NotificationUnreadCountResponse,
    SessionDescriptionPayload,
    SocialUserPublic,
    UnreadCountResponse,
    UserSearchResult,
    VoiceAttachmentPublic,
)


router = APIRouter(prefix="/social", tags=["social"])

BACKEND_ROOT = Path(__file__).resolve().parents[3]
MEDIA_ROOT = BACKEND_ROOT / "media"
VOICE_MEDIA_ROOT = MEDIA_ROOT / "voice"
MAX_VOICE_FILE_BYTES = 12 * 1024 * 1024
ALLOWED_AUDIO_MIME_TYPES = {
    "audio/webm",
    "audio/wav",
    "audio/x-wav",
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/x-m4a",
    "audio/aac",
    "audio/ogg",
}
MIME_EXTENSION_MAP = {
    "audio/webm": ".webm",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
}

VOICE_PREVIEW_LABEL = "Voice message"
CALL_EVENT_PREFIX = "__EL_CALL_EVENT__::"
CALL_RING_TIMEOUT_SECONDS = 35
CALL_CONNECTING_TIMEOUT_SECONDS = 90
CALL_ACTIVE_STATUSES = {"ringing", "connecting", "active"}
CALL_TERMINAL_STATUSES = {"ended", "declined", "missed", "canceled"}
CHALLENGE_TYPE_TITLES = {
    "quick_quiz": "Quick Quiz Challenge",
    "vocabulary": "Vocabulary Challenge",
    "grammar": "Grammar Challenge",
    "mixed": "Mixed Challenge",
}
CHALLENGE_QUESTION_COUNT = 10
CHALLENGE_PER_QUESTION_SECONDS = 18
logger = logging.getLogger("uvicorn.error")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def ensure_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def has_reached(timestamp: datetime | None, reference: datetime | None = None) -> bool:
    normalized_timestamp = ensure_utc(timestamp)
    if normalized_timestamp is None:
        return False
    normalized_reference = ensure_utc(reference or now_utc())
    if normalized_reference is None:
        return False
    return normalized_timestamp <= normalized_reference


def ordered_pair(first_id: int, second_id: int) -> tuple[int, int]:
    return (first_id, second_id) if first_id < second_id else (second_id, first_id)


def normalize_challenge_type(value: str | None) -> str:
    normalized = (value or "").strip().lower().replace(" ", "_")
    if normalized in CHALLENGE_TYPE_TITLES:
        return normalized
    return "quick_quiz"


def challenge_title_for_type(challenge_type: str, custom_title: str | None = None) -> str:
    normalized_custom = (custom_title or "").strip()
    if normalized_custom:
        return normalized_custom
    return CHALLENGE_TYPE_TITLES.get(challenge_type, CHALLENGE_TYPE_TITLES["quick_quiz"])


def sdp_preview(value: str, max_lines: int = 4, max_chars: int = 220) -> str:
    lines = [line.strip() for line in value.replace("\r", "\n").split("\n") if line.strip()]
    preview = " | ".join(lines[:max_lines])
    if len(preview) > max_chars:
        return f"{preview[:max_chars]}..."
    return preview


def decode_escaped_sdp(value: str) -> str:
    if not value:
        return value
    if "\n" in value or "\r" in value:
        return value
    if "\\r\\n" in value:
        return value.replace("\\r\\n", "\r\n")
    if "\\n" in value:
        return value.replace("\\n", "\n")
    if "\\r" in value:
        return value.replace("\\r", "\r")
    return value


def normalize_session_description(
    raw_value: str | SessionDescriptionPayload | dict,
    *,
    expected_type: str,
    field_name: str,
) -> str:
    declared_type: str | None = None
    sdp_value: str | None = None

    if isinstance(raw_value, SessionDescriptionPayload):
        declared_type = (
            raw_value.type.strip().lower()
            if isinstance(raw_value.type, str) and raw_value.type.strip()
            else None
        )
        sdp_value = raw_value.sdp
    elif isinstance(raw_value, dict):
        raw_type = raw_value.get("type")
        declared_type = (
            raw_type.strip().lower()
            if isinstance(raw_type, str) and raw_type.strip()
            else None
        )
        if declared_type == "candidate" or "candidate" in raw_value:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"{field_name} received an ICE candidate instead of SDP.",
            )
        sdp_value = raw_value.get("sdp") if isinstance(raw_value.get("sdp"), str) else None
    elif isinstance(raw_value, str):
        stripped = raw_value.strip()
        parsed: dict | None = None
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                maybe_payload = json.loads(stripped)
            except json.JSONDecodeError:
                maybe_payload = None
            if isinstance(maybe_payload, dict):
                parsed = maybe_payload

        if parsed and isinstance(parsed.get("sdp"), str):
            raw_type = parsed.get("type")
            declared_type = (
                raw_type.strip().lower()
                if isinstance(raw_type, str) and raw_type.strip()
                else None
            )
            if declared_type == "candidate" or "candidate" in parsed:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail=f"{field_name} received an ICE candidate instead of SDP.",
                )
            sdp_value = parsed["sdp"]
        else:
            sdp_value = raw_value
    else:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} must contain a valid WebRTC session description.",
        )

    if declared_type and declared_type != expected_type:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} type must be '{expected_type}'.",
        )

    normalized = decode_escaped_sdp((sdp_value or ""))
    if not normalized.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field_name} is required.",
        )

    sdp_lines = [line.strip() for line in normalized.splitlines() if line.strip()]
    if len(sdp_lines) < 5:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid {field_name}: incomplete SDP payload.",
        )
    if sdp_lines and (
        sdp_lines[0].startswith("a=")
        or sdp_lines[0].startswith("candidate:")
        or sdp_lines[0].startswith("a=candidate:")
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid {field_name}: partial SDP or ICE candidate was sent where full SDP was expected.",
        )
    if not sdp_lines or not sdp_lines[0].startswith("v=0"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid {field_name}: malformed SDP.",
        )
    if not any(line.startswith("o=") for line in sdp_lines):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid {field_name}: origin line is missing.",
        )
    if not any(line.startswith("s=") for line in sdp_lines):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid {field_name}: session name line is missing.",
        )
    if not any(line.startswith("t=") for line in sdp_lines):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid {field_name}: timing line is missing.",
        )
    if not any(line.startswith("m=") for line in sdp_lines):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid {field_name}: media line is missing.",
        )
    if sdp_lines and (
        sdp_lines[0].startswith("candidate:") or sdp_lines[0].startswith("a=candidate:")
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid {field_name}: ICE candidate was sent where SDP was expected.",
        )
    if any(not line or "=" not in line[:3] for line in sdp_lines):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid {field_name}: SDP contains malformed lines.",
        )

    logger.info(
        "Signaling %s received (%s chars, starts_v0=%s): %s",
        expected_type,
        len(normalized),
        normalized.startswith("v=0"),
        sdp_preview(normalized, max_chars=200),
    )
    return normalized


def normalize_ice_candidate_payload(raw_candidate: dict) -> dict:
    if not isinstance(raw_candidate, dict):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Candidate payload must be an object.",
        )
    if raw_candidate.get("type") in {"offer", "answer"} or isinstance(raw_candidate.get("sdp"), str):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="SDP was sent where an ICE candidate was expected.",
        )
    candidate_text = raw_candidate.get("candidate")
    if not isinstance(candidate_text, str) or not candidate_text.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Candidate payload is missing the candidate line.",
        )
    normalized_text = candidate_text.strip()
    if normalized_text.startswith("v=0") or "\nm=" in normalized_text or "\r\nm=" in normalized_text:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Session description was sent where an ICE candidate was expected.",
        )
    if normalized_text.startswith("a=") and not normalized_text.startswith("a=candidate:"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="SDP attribute fragment was sent where an ICE candidate was expected.",
        )
    if not (
        normalized_text.startswith("candidate:")
        or normalized_text.startswith("a=candidate:")
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="ICE candidate line must start with candidate:.",
        )
    if normalized_text.startswith("a=candidate:"):
        normalized_text = normalized_text[2:]

    return {
        "candidate": normalized_text,
        "sdpMid": raw_candidate.get("sdpMid")
        if isinstance(raw_candidate.get("sdpMid"), str) or raw_candidate.get("sdpMid") is None
        else None,
        "sdpMLineIndex": raw_candidate.get("sdpMLineIndex")
        if isinstance(raw_candidate.get("sdpMLineIndex"), int)
        else None,
        "usernameFragment": raw_candidate.get("usernameFragment")
        if isinstance(raw_candidate.get("usernameFragment"), str)
        else None,
    }


def extract_offer_payload(payload: CallCreateRequest) -> str | SessionDescriptionPayload | dict:
    if payload.offer_sdp is not None:
        return payload.offer_sdp
    if payload.type == "offer" and payload.sdp is not None:
        return payload.sdp
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail="Offer payload must include offer_sdp or { type: 'offer', sdp: ... }.",
    )


def extract_answer_payload(payload: CallAcceptRequest) -> str | SessionDescriptionPayload | dict:
    if payload.answer_sdp is not None:
        return payload.answer_sdp
    if payload.type == "answer" and payload.sdp is not None:
        return payload.sdp
    raise HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail="Answer payload must include answer_sdp or { type: 'answer', sdp: ... }.",
    )


def ensure_call_session_table(db: Session) -> None:
    bind = db.get_bind()
    if bind is None:
        return
    try:
        CallSession.__table__.create(bind=bind, checkfirst=True)
    except SQLAlchemyError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Voice call service is unavailable.",
        ) from exc


def direct_key_for_users(first_id: int, second_id: int) -> str:
    low, high = ordered_pair(first_id, second_id)
    return f"{low}:{high}"


def ensure_direct_conversation_between(db: Session, first_user_id: int, second_user_id: int) -> Conversation:
    direct_key = direct_key_for_users(first_user_id, second_user_id)
    conversation = db.scalar(select(Conversation).where(Conversation.direct_key == direct_key))
    if not conversation:
        conversation = Conversation(type="direct", direct_key=direct_key)
        db.add(conversation)
        db.flush()
        db.add_all(
            [
                ConversationParticipant(conversation_id=conversation.id, user_id=first_user_id),
                ConversationParticipant(conversation_id=conversation.id, user_id=second_user_id),
            ]
        )
        return conversation

    participant_ids = db.scalars(
        select(ConversationParticipant.user_id).where(
            ConversationParticipant.conversation_id == conversation.id
        )
    ).all()
    missing_participants = []
    if first_user_id not in participant_ids:
        missing_participants.append(
            ConversationParticipant(conversation_id=conversation.id, user_id=first_user_id)
        )
    if second_user_id not in participant_ids:
        missing_participants.append(
            ConversationParticipant(conversation_id=conversation.id, user_id=second_user_id)
        )
    if missing_participants:
        db.add_all(missing_participants)
    return conversation


def to_social_user(user: User) -> SocialUserPublic:
    return SocialUserPublic(
        id=user.id,
        username=user.username,
        display_name=user.username,
        email=user.email,
    )


def parse_metadata(metadata_json: str | None) -> dict | None:
    if not metadata_json:
        return None
    try:
        parsed = json.loads(metadata_json)
        if isinstance(parsed, dict):
            return parsed
        return {"value": parsed}
    except json.JSONDecodeError:
        return None


def parse_challenge_metadata(challenge: Challenge) -> dict:
    metadata = parse_metadata(challenge.metadata_json)
    if isinstance(metadata, dict):
        return metadata
    return {}


def save_challenge_metadata(challenge: Challenge, metadata: dict) -> None:
    challenge.metadata_json = json.dumps(metadata, separators=(",", ":")) if metadata else None


def parse_json_array(payload: str | None) -> list[dict]:
    if not payload:
        return []
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    sanitized: list[dict] = []
    for item in parsed:
        if isinstance(item, dict):
            sanitized.append(item)
    return sanitized


def parse_candidate_json_array(payload: str | None) -> list[dict]:
    candidates = parse_json_array(payload)
    sanitized: list[dict] = []
    for candidate in candidates:
        try:
            sanitized.append(normalize_ice_candidate_payload(candidate))
        except HTTPException as exc:
            logger.warning(
                "Dropping invalid stored ICE candidate: %s",
                exc.detail,
            )
    return sanitized


def serialize_json_array(values: list[dict]) -> str | None:
    if not values:
        return None
    return json.dumps(values, separators=(",", ":"))


def format_call_event_label(event_type: str, duration_seconds: int | None = None) -> str:
    if event_type == "missed":
        return "Missed call"
    if event_type == "declined":
        return "Call declined"
    if event_type == "canceled":
        return "Call canceled"
    if event_type == "ended":
        duration_label = format_seconds_label(duration_seconds)
        if duration_label:
            return f"Call ended ({duration_label})"
        return "Call ended"
    if event_type == "started":
        return "Calling..."
    if event_type == "connected":
        return "Call connected"
    return "Call update"


def build_call_event_body(
    *,
    event_type: str,
    call_id: int,
    actor_id: int,
    duration_seconds: int | None = None,
    note: str | None = None,
) -> str:
    payload = {
        "event_type": event_type,
        "call_id": call_id,
        "actor_id": actor_id,
        "duration_seconds": duration_seconds,
        "note": note,
    }
    return f"{CALL_EVENT_PREFIX}{json.dumps(payload, separators=(',', ':'))}"


def parse_call_event_body(body: str | None) -> dict | None:
    if not body or not body.startswith(CALL_EVENT_PREFIX):
        return None
    raw_payload = body[len(CALL_EVENT_PREFIX) :]
    try:
        parsed = json.loads(raw_payload)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


def create_call_event_message(
    db: Session,
    *,
    conversation_id: int,
    sender_id: int,
    event_type: str,
    call_id: int,
    duration_seconds: int | None = None,
    note: str | None = None,
    created_at: datetime | None = None,
) -> Message:
    event_body = build_call_event_body(
        event_type=event_type,
        call_id=call_id,
        actor_id=sender_id,
        duration_seconds=duration_seconds,
        note=note,
    )
    timestamp = created_at or now_utc()
    event_message = Message(
        conversation_id=conversation_id,
        sender_id=sender_id,
        body=event_body,
        is_seen=True,
        seen_at=timestamp,
        created_at=timestamp,
        updated_at=timestamp,
    )
    db.add(event_message)
    return event_message


def format_seconds_label(total_seconds: int | None) -> str | None:
    if total_seconds is None:
        return None
    safe_total = max(0, int(total_seconds))
    minutes, seconds = divmod(safe_total, 60)
    return f"{minutes}:{seconds:02d}"


def build_voice_preview_label(duration_seconds: int | None) -> str:
    duration_label = format_seconds_label(duration_seconds)
    if duration_label:
        return f"{VOICE_PREVIEW_LABEL} ({duration_label})"
    return VOICE_PREVIEW_LABEL


def infer_audio_extension(filename: str | None, mime_type: str) -> str:
    if filename:
        suffix = Path(filename).suffix.lower()
        if suffix in {".webm", ".wav", ".mp3", ".m4a", ".aac", ".ogg"}:
            return suffix
    return MIME_EXTENSION_MAP.get(mime_type, ".webm")


def normalize_audio_mime_type(content_type: str | None) -> str:
    candidate = (content_type or "audio/webm").split(";", 1)[0].strip().lower()
    if candidate in ALLOWED_AUDIO_MIME_TYPES:
        return candidate
    raise HTTPException(
        status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        detail="Unsupported audio format.",
    )


def save_voice_file(
    *,
    conversation_id: int,
    filename: str | None,
    mime_type: str,
    payload: bytes,
) -> tuple[str, str]:
    VOICE_MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    conversation_folder = VOICE_MEDIA_ROOT / f"conversation-{conversation_id}"
    conversation_folder.mkdir(parents=True, exist_ok=True)

    extension = infer_audio_extension(filename, mime_type)
    file_name = f"voice-{uuid4().hex}{extension}"
    file_path = conversation_folder / file_name
    file_path.write_bytes(payload)

    relative_path = file_path.relative_to(MEDIA_ROOT).as_posix()
    return relative_path, f"/media/{relative_path}"


def get_voice_map_for_messages(
    db: Session, message_ids: list[int] | set[int]
) -> dict[int, VoiceMessage]:
    if not message_ids:
        return {}
    rows = db.scalars(
        select(VoiceMessage).where(VoiceMessage.message_id.in_(list(message_ids)))
    ).all()
    return {row.message_id: row for row in rows}


def to_voice_public(voice_message: VoiceMessage) -> VoiceAttachmentPublic:
    return VoiceAttachmentPublic(
        url=voice_message.public_url,
        duration_seconds=voice_message.duration_seconds,
        mime_type=voice_message.mime_type,
        file_size_bytes=voice_message.file_size_bytes,
    )


def to_message_public(
    message: Message, voice_map: dict[int, VoiceMessage] | None = None
) -> MessagePublic:
    voice_message = voice_map.get(message.id) if voice_map else None
    if voice_message:
        return MessagePublic(
            id=message.id,
            conversation_id=message.conversation_id,
            sender_id=message.sender_id,
            body=message.body or VOICE_PREVIEW_LABEL,
            kind="voice",
            voice=to_voice_public(voice_message),
            metadata=None,
            is_seen=message.is_seen,
            seen_at=message.seen_at,
            created_at=message.created_at,
            updated_at=message.updated_at,
        )
    call_event = parse_call_event_body(message.body)
    if call_event:
        event_type = str(call_event.get("event_type") or "").strip().lower() or "updated"
        duration_seconds = (
            int(call_event["duration_seconds"])
            if call_event.get("duration_seconds") is not None
            and str(call_event.get("duration_seconds")).strip().lstrip("-").isdigit()
            else None
        )
        return MessagePublic(
            id=message.id,
            conversation_id=message.conversation_id,
            sender_id=message.sender_id,
            body=format_call_event_label(event_type, duration_seconds),
            kind="call_event",
            voice=None,
            metadata={
                "event_type": event_type,
                "call_id": call_event.get("call_id"),
                "actor_id": call_event.get("actor_id"),
                "duration_seconds": duration_seconds,
                "note": call_event.get("note"),
            },
            is_seen=message.is_seen,
            seen_at=message.seen_at,
            created_at=message.created_at,
            updated_at=message.updated_at,
        )
    return MessagePublic(
        id=message.id,
        conversation_id=message.conversation_id,
        sender_id=message.sender_id,
        body=message.body,
        kind="text",
        voice=None,
        metadata=None,
        is_seen=message.is_seen,
        seen_at=message.seen_at,
        created_at=message.created_at,
        updated_at=message.updated_at,
    )


def get_users_map(db: Session, user_ids: set[int]) -> dict[int, User]:
    if not user_ids:
        return {}
    return {
        user.id: user for user in db.scalars(select(User).where(User.id.in_(user_ids))).all()
    }


def get_friendship_between(db: Session, first_id: int, second_id: int) -> Friendship | None:
    low, high = ordered_pair(first_id, second_id)
    return db.scalar(
        select(Friendship).where(
            Friendship.user_one_id == low,
            Friendship.user_two_id == high,
        )
    )


def assert_conversation_participant(
    db: Session, conversation_id: int, user_id: int
) -> Conversation:
    conversation = db.get(Conversation, conversation_id)
    if not conversation:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found."
        )

    is_participant = db.scalar(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == conversation_id,
            ConversationParticipant.user_id == user_id,
        )
    )
    if not is_participant:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not allowed to access this conversation.",
        )
    return conversation


def get_direct_peer_id(db: Session, conversation_id: int, current_user_id: int) -> int:
    participant_user_ids = db.scalars(
        select(ConversationParticipant.user_id).where(
            ConversationParticipant.conversation_id == conversation_id
        )
    ).all()
    peer_ids = [
        participant_id
        for participant_id in participant_user_ids
        if participant_id != current_user_id
    ]
    if len(peer_ids) != 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid direct conversation participants.",
        )
    return peer_ids[0]


def to_session_description_payload(
    sdp_value: str | None, expected_type: str, call_id: int
) -> dict | None:
    if not sdp_value:
        return None
    try:
        normalized = normalize_session_description(
            sdp_value,
            expected_type=expected_type,
            field_name=f"{expected_type}_sdp",
        )
    except HTTPException as exc:
        logger.warning(
            "Dropping invalid stored %s SDP for call %s: %s",
            expected_type,
            call_id,
            exc.detail,
        )
        return None
    starts_with_v0 = normalized.startswith("v=0")
    logger.info(
        "Signaling %s sent for call %s (%s chars, starts_v0=%s): %s",
        expected_type,
        call_id,
        len(normalized),
        starts_with_v0,
        sdp_preview(normalized, max_chars=200),
    )
    return {"type": expected_type, "sdp": normalized}


def to_call_public(call: CallSession, current_user: User, users_by_id: dict[int, User]) -> CallPublic:
    caller = users_by_id.get(call.caller_id)
    callee = users_by_id.get(call.callee_id)
    if not caller or not callee:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Call users are unavailable.",
        )

    status_value = (call.status or "ringing").strip().lower()
    is_outgoing = current_user.id == call.caller_id
    is_incoming = current_user.id == call.callee_id
    can_accept = status_value == "ringing" and is_incoming
    can_decline = status_value == "ringing" and is_incoming
    can_cancel = status_value in {"ringing", "connecting"} and is_outgoing
    can_end = status_value in {"connecting", "active"} and current_user.id in {
        call.caller_id,
        call.callee_id,
    }

    return CallPublic(
        id=call.id,
        conversation_id=call.conversation_id,
        caller=to_social_user(caller),
        callee=to_social_user(callee),
        status=status_value,
        offer_sdp=to_session_description_payload(call.offer_sdp, "offer", call.id),
        answer_sdp=to_session_description_payload(call.answer_sdp, "answer", call.id),
        caller_candidates=parse_candidate_json_array(call.caller_candidates_json),
        callee_candidates=parse_candidate_json_array(call.callee_candidates_json),
        created_at=call.created_at,
        updated_at=call.updated_at,
        connected_at=call.connected_at,
        ended_at=call.ended_at,
        duration_seconds=call.duration_seconds,
        is_outgoing=is_outgoing,
        is_incoming=is_incoming,
        can_accept=can_accept,
        can_decline=can_decline,
        can_cancel=can_cancel,
        can_end=can_end,
    )


def get_call_for_actor(db: Session, call_id: int, current_user: User) -> CallSession:
    ensure_call_session_table(db)
    call = db.get(CallSession, call_id)
    if not call:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Call not found.",
        )

    if current_user.id not in {call.caller_id, call.callee_id}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not allowed to access this call.",
        )

    participant = db.scalar(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == call.conversation_id,
            ConversationParticipant.user_id == current_user.id,
        )
    )
    if not participant:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not allowed to access this call.",
        )

    return call


def get_latest_call_for_conversation(
    db: Session, conversation_id: int, current_user: User
) -> CallSession | None:
    ensure_call_session_table(db)
    return db.scalar(
        select(CallSession)
        .where(
            CallSession.conversation_id == conversation_id,
            or_(
                CallSession.caller_id == current_user.id,
                CallSession.callee_id == current_user.id,
            ),
        )
        .order_by(CallSession.created_at.desc(), CallSession.id.desc())
    )


def append_candidate_json(existing_json: str | None, candidate_payload: dict) -> str | None:
    existing = parse_json_array(existing_json)
    candidate_signature = json.dumps(candidate_payload, sort_keys=True, separators=(",", ":"))
    existing_signatures = {
        json.dumps(item, sort_keys=True, separators=(",", ":")) for item in existing
    }
    if candidate_signature not in existing_signatures:
        existing.append(candidate_payload)
    return serialize_json_array(existing)


def resolve_call_duration_seconds(call: CallSession, finished_at: datetime | None = None) -> int | None:
    end_time = finished_at or call.ended_at
    if not call.connected_at or not end_time:
        return None
    elapsed = int(max(0, (ensure_utc(end_time) - ensure_utc(call.connected_at)).total_seconds()))
    return elapsed


def finalize_call_status(
    db: Session,
    *,
    call: CallSession,
    status_value: str,
    actor_user_id: int,
    ended_at: datetime,
    create_event: bool = True,
    event_note: str | None = None,
) -> None:
    if call.status in CALL_TERMINAL_STATUSES:
        return

    call.status = status_value
    call.ended_at = ended_at
    call.duration_seconds = resolve_call_duration_seconds(call, ended_at)
    call.updated_at = ended_at

    conversation = db.get(Conversation, call.conversation_id)
    if conversation:
        conversation.updated_at = ended_at

    if create_event:
        create_call_event_message(
            db,
            conversation_id=call.conversation_id,
            sender_id=actor_user_id,
            event_type=status_value,
            call_id=call.id,
            duration_seconds=call.duration_seconds,
            note=event_note,
            created_at=ended_at,
        )


def expire_stale_calls(
    db: Session,
    *,
    conversation_ids: list[int] | None = None,
) -> set[int]:
    ensure_call_session_table(db)
    now = now_utc()
    ringing_expiry_threshold = now - timedelta(seconds=CALL_RING_TIMEOUT_SECONDS)
    connecting_expiry_threshold = now - timedelta(seconds=CALL_CONNECTING_TIMEOUT_SECONDS)

    query = select(CallSession).where(
        or_(
            and_(
                CallSession.status == "ringing",
                CallSession.created_at <= ringing_expiry_threshold,
            ),
            and_(
                CallSession.status == "connecting",
                CallSession.updated_at <= connecting_expiry_threshold,
            ),
        )
    )
    if conversation_ids is not None:
        if not conversation_ids:
            return set()
        query = query.where(CallSession.conversation_id.in_(conversation_ids))

    stale_calls = db.scalars(query).all()
    if not stale_calls:
        return set()

    changed_conversation_ids: set[int] = set()
    for call in stale_calls:
        next_status = "missed" if call.status == "ringing" else "canceled"
        event_note = "No answer" if call.status == "ringing" else "Connection timed out"
        finalize_call_status(
            db,
            call=call,
            status_value=next_status,
            actor_user_id=call.caller_id,
            ended_at=now,
            create_event=True,
            event_note=event_note,
        )
        changed_conversation_ids.add(call.conversation_id)

        create_notification(
            db,
            user_id=call.callee_id,
            notification_type="call_missed" if next_status == "missed" else "call_canceled",
            title="Missed call" if next_status == "missed" else "Call ended",
            body="You missed a voice call." if next_status == "missed" else "Voice call timed out.",
            related_user_id=call.caller_id,
            related_conversation_id=call.conversation_id,
            metadata={"call_id": call.id},
        )

    db.commit()

    deliver_session_notifications(db)
    return changed_conversation_ids


def expire_single_call_if_needed(db: Session, call: CallSession) -> bool:
    if call.status != "ringing":
        if call.status != "connecting":
            return False
        updated_at = ensure_utc(call.updated_at)
        if updated_at is None:
            return False
        if updated_at > now_utc() - timedelta(seconds=CALL_CONNECTING_TIMEOUT_SECONDS):
            return False
        finalize_call_status(
            db,
            call=call,
            status_value="canceled",
            actor_user_id=call.caller_id,
            ended_at=now_utc(),
            create_event=True,
            event_note="Connection timed out",
        )
        create_notification(
            db,
            user_id=call.callee_id,
            notification_type="call_canceled",
            title="Call ended",
            body="Voice call timed out.",
            related_user_id=call.caller_id,
            related_conversation_id=call.conversation_id,
            metadata={"call_id": call.id},
        )
        db.commit()
        deliver_session_notifications(db)
        return True

    created_at = ensure_utc(call.created_at)
    if not created_at:
        return False

    if created_at > now_utc() - timedelta(seconds=CALL_RING_TIMEOUT_SECONDS):
        return False

    finalize_call_status(
        db,
        call=call,
        status_value="missed",
        actor_user_id=call.caller_id,
        ended_at=now_utc(),
        create_event=True,
        event_note="No answer",
    )
    create_notification(
        db,
        user_id=call.callee_id,
        notification_type="call_missed",
        title="Missed call",
        body="You missed a voice call.",
        related_user_id=call.caller_id,
        related_conversation_id=call.conversation_id,
        metadata={"call_id": call.id},
    )
    db.commit()
    deliver_session_notifications(db)
    return True


def sync_challenge_expiration(
    challenge: Challenge, current_time: datetime | None = None
) -> bool:
    check_time = current_time or now_utc()
    if challenge.status == "pending" and has_reached(challenge.expires_at, check_time):
        challenge.status = "expired"
        challenge.responded_at = check_time
        challenge.updated_at = check_time
        return True
    return False


def expire_pending_challenges(
    db: Session,
    *,
    conversation_ids: list[int] | None = None,
    challenge_ids: list[int] | None = None,
) -> set[int]:
    query = select(Challenge).where(
        Challenge.status == "pending",
        Challenge.expires_at.is_not(None),
        Challenge.expires_at <= now_utc(),
    )
    if conversation_ids is not None:
        if not conversation_ids:
            return set()
        query = query.where(Challenge.conversation_id.in_(conversation_ids))
    if challenge_ids is not None:
        if not challenge_ids:
            return set()
        query = query.where(Challenge.id.in_(challenge_ids))

    stale_challenges = db.scalars(query).all()
    if not stale_challenges:
        return set()

    expired_at = now_utc()
    changed_conversation_ids: set[int] = set()
    for challenge in stale_challenges:
        if sync_challenge_expiration(challenge, expired_at):
            changed_conversation_ids.add(challenge.conversation_id)

    for conversation_id in changed_conversation_ids:
        conversation = db.get(Conversation, conversation_id)
        if conversation:
            conversation.updated_at = expired_at

    db.commit()

    deliver_session_notifications(db)
    return changed_conversation_ids


def to_challenge_public(
    challenge: Challenge,
    current_user: User,
    users_by_id: dict[int, User],
) -> ChallengePublic:
    challenger = users_by_id.get(challenge.challenger_id)
    challenged = users_by_id.get(challenge.challenged_id)
    if not challenger or not challenged:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Challenge users are unavailable.",
        )

    now = now_utc()
    is_expired = challenge.status == "expired" or (
        challenge.status == "pending" and has_reached(challenge.expires_at, now)
    )
    is_pending_actionable = challenge.status == "pending" and not is_expired
    metadata = parse_challenge_metadata(challenge)
    challenger_result = metadata.get("challenger_result") if isinstance(metadata.get("challenger_result"), dict) else None
    challenged_result = metadata.get("challenged_result") if isinstance(metadata.get("challenged_result"), dict) else None

    can_accept = is_pending_actionable and current_user.id == challenge.challenged_id
    can_decline = is_pending_actionable and current_user.id == challenge.challenged_id
    can_cancel = is_pending_actionable and current_user.id == challenge.challenger_id
    can_start = challenge.status == "accepted" and current_user.id in {
        challenge.challenger_id,
        challenge.challenged_id,
    }
    can_submit = can_start and (
        (current_user.id == challenge.challenger_id and challenger_result is None)
        or (current_user.id == challenge.challenged_id and challenged_result is None)
    )
    can_view_result = challenge.status == "completed" or (
        challenge.status == "accepted" and (challenger_result is not None or challenged_result is not None)
    )
    can_rematch = challenge.status in {"completed", "declined", "expired", "canceled"} and current_user.id in {
        challenge.challenger_id,
        challenge.challenged_id,
    }
    awaiting_opponent_result = challenge.status == "accepted" and (
        (current_user.id == challenge.challenger_id and challenger_result is not None and challenged_result is None)
        or (current_user.id == challenge.challenged_id and challenged_result is not None and challenger_result is None)
    )

    return ChallengePublic(
        id=challenge.id,
        conversation_id=challenge.conversation_id,
        challenger=to_social_user(challenger),
        challenged=to_social_user(challenged),
        title=challenge.title,
        challenge_type=normalize_challenge_type(challenge.challenge_type),
        status=challenge.status if not is_expired else "expired",
        category=challenge.category,
        difficulty=challenge.difficulty,
        challenger_score=challenge.challenger_score,
        challenged_score=challenge.challenged_score,
        winner_id=challenge.winner_id,
        started_at=challenge.started_at,
        created_at=challenge.created_at,
        updated_at=challenge.updated_at,
        responded_at=challenge.responded_at,
        expires_at=challenge.expires_at,
        completed_at=challenge.completed_at,
        result_summary=challenge.result_summary,
        metadata=metadata or None,
        is_expired=is_expired,
        can_accept=can_accept,
        can_decline=can_decline,
        can_cancel=can_cancel,
        can_start=can_start,
        can_submit=can_submit,
        can_view_result=can_view_result,
        can_rematch=can_rematch,
        is_actionable_by_current=can_accept or can_decline or can_cancel or can_start or can_submit or can_rematch,
        awaiting_opponent_result=awaiting_opponent_result,
    )


def to_notification_public(
    notification: Notification, users_by_id: dict[int, User]
) -> NotificationPublic:
    related_user = users_by_id.get(notification.related_user_id)

    return NotificationPublic(
        id=notification.id,
        user_id=notification.user_id,
        type=notification.type,
        title=notification.title,
        body=notification.body,
        is_read=notification.is_read,
        created_at=notification.created_at,
        related_user=to_social_user(related_user) if related_user else None,
        related_conversation_id=notification.related_conversation_id,
        related_challenge_id=notification.related_challenge_id,
        metadata=parse_metadata(notification.metadata_json),
    )


def notification_payload_for_delivery(db: Session, notification: Notification) -> dict:
    users_by_id: dict[int, User] = {}
    if notification.related_user_id:
        related_user = db.get(User, notification.related_user_id)
        if related_user:
            users_by_id[related_user.id] = related_user
    return to_notification_public(notification, users_by_id).model_dump(mode="json")


def unread_notification_count(db: Session, user_id: int) -> int:
    return int(
        db.scalar(
            select(func.count(Notification.id)).where(
                Notification.user_id == user_id,
                Notification.is_read.is_(False),
            )
        )
        or 0
    )


def deliver_notification_realtime(db: Session, notification: Notification | None) -> None:
    if not notification or not notification.id:
        return
    payload = notification_payload_for_delivery(db, notification)
    unread_count = unread_notification_count(db, notification.user_id)
    try:
        from_thread.run(
            partial(
                notification_manager.send_notification,
                user_id=notification.user_id,
                notification=payload,
                unread_count=unread_count,
            )
        )
    except RuntimeError:
        logger.info(
            "Notification realtime delivery skipped outside async context: notification=%s user=%s",
            notification.id,
            notification.user_id,
        )
    except Exception as exc:
        logger.warning(
            "Notification realtime delivery failed: notification=%s user=%s error=%s",
            notification.id,
            notification.user_id,
            exc,
        )


def deliver_unread_count_realtime(db: Session, user_id: int) -> None:
    try:
        from_thread.run(
            partial(
                notification_manager.send_unread_count,
                user_id=user_id,
                unread_count=unread_notification_count(db, user_id),
            )
        )
    except RuntimeError:
        logger.info("Notification unread realtime sync skipped outside async context: user=%s", user_id)
    except Exception as exc:
        logger.warning("Notification unread realtime sync failed: user=%s error=%s", user_id, exc)


def queue_notification_for_realtime(db: Session, notification: Notification) -> None:
    pending = db.info.setdefault("pending_realtime_notifications", [])
    pending.append(notification)


def deliver_session_notifications(db: Session) -> None:
    pending = db.info.pop("pending_realtime_notifications", [])
    for notification in pending:
        deliver_notification_realtime(db, notification)


def create_notification(
    db: Session,
    *,
    user_id: int,
    notification_type: str,
    title: str,
    body: str,
    related_user_id: int | None = None,
    related_conversation_id: int | None = None,
    related_challenge_id: int | None = None,
    metadata: dict | None = None,
) -> Notification | None:
    normalized_title = title.strip()
    normalized_body = body.strip()
    if not normalized_title or not normalized_body:
        return None

    notification = Notification(
        user_id=user_id,
        type=notification_type,
        title=normalized_title,
        body=normalized_body,
        related_user_id=related_user_id,
        related_conversation_id=related_conversation_id,
        related_challenge_id=related_challenge_id,
        metadata_json=json.dumps(metadata) if metadata else None,
    )
    db.add(notification)
    db.flush()
    queue_notification_for_realtime(db, notification)
    return notification


def get_challenge_for_actor(
    db: Session, challenge_id: int, current_user: User
) -> Challenge:
    challenge = db.get(Challenge, challenge_id)
    if not challenge:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Challenge not found."
        )

    if current_user.id not in {challenge.challenger_id, challenge.challenged_id}:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not allowed to access this challenge.",
        )

    participant = db.scalar(
        select(ConversationParticipant.id).where(
            ConversationParticipant.conversation_id == challenge.conversation_id,
            ConversationParticipant.user_id == current_user.id,
        )
    )
    if not participant:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not allowed to access this challenge.",
        )

    if sync_challenge_expiration(challenge):
        conversation = db.get(Conversation, challenge.conversation_id)
        if conversation:
            conversation.updated_at = now_utc()
        db.commit()
        deliver_session_notifications(db)
        db.refresh(challenge)

    return challenge


def load_conversation_payloads(
    db: Session, current_user: User, conversation_ids: list[int]
) -> tuple[list[ConversationPublic], int]:
    if not conversation_ids:
        return [], 0

    conversation_rows = db.scalars(
        select(Conversation)
        .where(Conversation.id.in_(conversation_ids))
        .order_by(Conversation.updated_at.desc(), Conversation.id.desc())
    ).all()
    if not conversation_rows:
        return [], 0

    participant_rows = db.scalars(
        select(ConversationParticipant).where(
            ConversationParticipant.conversation_id.in_(conversation_ids)
        )
    ).all()

    participants_by_conversation: dict[int, list[ConversationParticipant]] = {}
    peer_ids: set[int] = set()
    for participant in participant_rows:
        participants_by_conversation.setdefault(participant.conversation_id, []).append(
            participant
        )
        if participant.user_id != current_user.id:
            peer_ids.add(participant.user_id)

    users_by_id: dict[int, User] = {}
    if peer_ids:
        peer_users = db.scalars(select(User).where(User.id.in_(peer_ids))).all()
        users_by_id = {user.id: user for user in peer_users}

    friend_peer_ids: set[int] = set()
    if peer_ids:
        friendship_rows = db.scalars(
            select(Friendship).where(
                or_(
                    and_(
                        Friendship.user_one_id == current_user.id,
                        Friendship.user_two_id.in_(peer_ids),
                    ),
                    and_(
                        Friendship.user_two_id == current_user.id,
                        Friendship.user_one_id.in_(peer_ids),
                    ),
                )
            )
        ).all()
        for friendship in friendship_rows:
            friend_peer_ids.add(
                friendship.user_two_id
                if friendship.user_one_id == current_user.id
                else friendship.user_one_id
            )

    latest_message_rows = db.scalars(
        select(Message)
        .where(Message.conversation_id.in_(conversation_ids))
        .order_by(Message.created_at.desc(), Message.id.desc())
    ).all()
    latest_message_by_conversation: dict[int, Message] = {}
    for message in latest_message_rows:
        if message.conversation_id not in latest_message_by_conversation:
            latest_message_by_conversation[message.conversation_id] = message
    latest_message_voice_map = get_voice_map_for_messages(
        db, [message.id for message in latest_message_by_conversation.values()]
    )

    latest_challenge_rows = db.scalars(
        select(Challenge)
        .where(Challenge.conversation_id.in_(conversation_ids))
        .order_by(Challenge.updated_at.desc(), Challenge.id.desc())
    ).all()
    latest_challenge_by_conversation: dict[int, Challenge] = {}
    for challenge in latest_challenge_rows:
        if challenge.conversation_id not in latest_challenge_by_conversation:
            latest_challenge_by_conversation[challenge.conversation_id] = challenge

    unread_rows = db.execute(
        select(Message.conversation_id, func.count(Message.id))
        .where(
            Message.conversation_id.in_(conversation_ids),
            Message.sender_id != current_user.id,
            Message.is_seen.is_(False),
        )
        .group_by(Message.conversation_id)
    ).all()
    unread_map = {conversation_id: count for conversation_id, count in unread_rows}

    payloads: list[ConversationPublic] = []
    for conversation in conversation_rows:
        participants = participants_by_conversation.get(conversation.id, [])
        peer_id = next(
            (
                participant.user_id
                for participant in participants
                if participant.user_id != current_user.id
            ),
            None,
        )
        if peer_id is None:
            continue

        peer = users_by_id.get(peer_id)
        if not peer:
            continue

        latest_message = latest_message_by_conversation.get(conversation.id)
        latest_challenge = latest_challenge_by_conversation.get(conversation.id)

        last_preview: MessagePreview | None = None
        latest_message_at = ensure_utc(latest_message.created_at) if latest_message else None
        latest_challenge_at = ensure_utc(latest_challenge.updated_at) if latest_challenge else None
        latest_message_is_newer = latest_message_at is not None and (
            latest_challenge_at is None or latest_message_at >= latest_challenge_at
        )

        if latest_message and latest_message_is_newer:
            voice_message = latest_message_voice_map.get(latest_message.id)
            call_event = parse_call_event_body(latest_message.body)
            if voice_message:
                preview_body = build_voice_preview_label(voice_message.duration_seconds)
                preview_kind = "voice"
                preview_duration = voice_message.duration_seconds
            elif call_event:
                event_type = str(call_event.get("event_type") or "").strip().lower() or "updated"
                event_duration = (
                    int(call_event["duration_seconds"])
                    if call_event.get("duration_seconds") is not None
                    and str(call_event.get("duration_seconds")).strip().lstrip("-").isdigit()
                    else None
                )
                preview_body = format_call_event_label(event_type, event_duration)
                preview_kind = "call_event"
                preview_duration = None
            else:
                preview_body = latest_message.body
                preview_kind = "message"
                preview_duration = None
            last_preview = MessagePreview(
                id=latest_message.id,
                body=preview_body,
                sender_id=latest_message.sender_id,
                created_at=latest_message.created_at,
                is_seen=latest_message.is_seen,
                kind=preview_kind,
                voice_duration_seconds=preview_duration,
            )
        elif latest_challenge:
            challenge_status = latest_challenge.status.capitalize()
            last_preview = MessagePreview(
                id=latest_challenge.id,
                body=f"Challenge: {latest_challenge.title} ({challenge_status})",
                sender_id=latest_challenge.challenger_id,
                created_at=latest_challenge.updated_at,
                is_seen=True,
                kind="challenge",
            )

        payloads.append(
            ConversationPublic(
                id=conversation.id,
                peer=to_social_user(peer),
                created_at=conversation.created_at,
                updated_at=conversation.updated_at,
                can_message=peer_id in friend_peer_ids,
                unread_count=int(unread_map.get(conversation.id, 0)),
                last_message=last_preview,
            )
        )

    total_unread = sum(payload.unread_count for payload in payloads)
    return payloads, total_unread


@router.get("/users/search", response_model=list[UserSearchResult])
def search_users(
    q: str = Query(default="", min_length=0, max_length=100),
    limit: int = Query(default=20, ge=1, le=50),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = q.strip()
    if not query:
        return []

    query_lower = query.lower()
    username_lower = func.lower(User.username)
    email_lower = func.lower(User.email)
    relevance_order = case(
        (username_lower == query_lower, 0),
        (username_lower.like(f"{query_lower}%"), 1),
        (email_lower.like(f"{query_lower}%"), 2),
        else_=3,
    )

    users = db.scalars(
        select(User)
        .where(
            User.id != current_user.id,
            or_(
                username_lower.like(f"%{query_lower}%"),
                email_lower.like(f"%{query_lower}%"),
            ),
        )
        .order_by(relevance_order.asc(), username_lower.asc(), User.id.asc())
        .limit(limit)
    ).all()
    if not users:
        return []

    user_ids = [user.id for user in users]

    friendship_rows = db.scalars(
        select(Friendship).where(
            or_(
                and_(
                    Friendship.user_one_id == current_user.id,
                    Friendship.user_two_id.in_(user_ids),
                ),
                and_(
                    Friendship.user_two_id == current_user.id,
                    Friendship.user_one_id.in_(user_ids),
                ),
            )
        )
    ).all()
    friend_ids: set[int] = set()
    for friendship in friendship_rows:
        friend_ids.add(
            friendship.user_two_id
            if friendship.user_one_id == current_user.id
            else friendship.user_one_id
        )

    pending_requests = db.scalars(
        select(FriendRequest).where(
            FriendRequest.status == "pending",
            or_(
                and_(
                    FriendRequest.sender_id == current_user.id,
                    FriendRequest.receiver_id.in_(user_ids),
                ),
                and_(
                    FriendRequest.receiver_id == current_user.id,
                    FriendRequest.sender_id.in_(user_ids),
                ),
            ),
        )
    ).all()

    incoming_request_ids: dict[int, int] = {}
    outgoing_request_ids: dict[int, int] = {}
    for request in pending_requests:
        if request.sender_id == current_user.id:
            outgoing_request_ids[request.receiver_id] = request.id
        else:
            incoming_request_ids[request.sender_id] = request.id

    results: list[UserSearchResult] = []
    for user in users:
        if user.id in friend_ids:
            relationship_status = "friend"
            request_id = None
        elif user.id in incoming_request_ids:
            relationship_status = "incoming_request"
            request_id = incoming_request_ids[user.id]
        elif user.id in outgoing_request_ids:
            relationship_status = "outgoing_request"
            request_id = outgoing_request_ids[user.id]
        else:
            relationship_status = "none"
            request_id = None

        results.append(
            UserSearchResult(
                user=to_social_user(user),
                relationship_status=relationship_status,
                request_id=request_id,
            )
        )

    return results


@router.get("/friends", response_model=list[FriendshipPublic])
def list_friends(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    friendships = db.scalars(
        select(Friendship)
        .where(
            or_(
                Friendship.user_one_id == current_user.id,
                Friendship.user_two_id == current_user.id,
            )
        )
        .order_by(Friendship.created_at.desc(), Friendship.id.desc())
    ).all()
    if not friendships:
        return []

    friend_ids = [
        friendship.user_two_id
        if friendship.user_one_id == current_user.id
        else friendship.user_one_id
        for friendship in friendships
    ]
    users_by_id = {
        user.id: user
        for user in db.scalars(select(User).where(User.id.in_(friend_ids))).all()
    }

    response: list[FriendshipPublic] = []
    for friendship in friendships:
        friend_id = (
            friendship.user_two_id
            if friendship.user_one_id == current_user.id
            else friendship.user_one_id
        )
        friend_user = users_by_id.get(friend_id)
        if not friend_user:
            continue

        response.append(
            FriendshipPublic(
                id=friendship.id,
                friend=to_social_user(friend_user),
                created_at=friendship.created_at,
            )
        )

    return response


@router.get("/requests", response_model=FriendRequestsBundle)
def list_friend_requests(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    incoming = db.scalars(
        select(FriendRequest)
        .where(
            FriendRequest.receiver_id == current_user.id,
            FriendRequest.status == "pending",
        )
        .order_by(FriendRequest.created_at.desc(), FriendRequest.id.desc())
    ).all()
    outgoing = db.scalars(
        select(FriendRequest)
        .where(
            FriendRequest.sender_id == current_user.id,
            FriendRequest.status == "pending",
        )
        .order_by(FriendRequest.created_at.desc(), FriendRequest.id.desc())
    ).all()

    user_ids = {request.sender_id for request in incoming}
    user_ids.update({request.receiver_id for request in outgoing})
    user_ids.add(current_user.id)
    users_by_id = {current_user.id: current_user}
    if user_ids:
        users_by_id.update(
            {
                user.id: user
                for user in db.scalars(select(User).where(User.id.in_(user_ids))).all()
            }
        )

    def serialize_request(request: FriendRequest) -> FriendRequestPublic | None:
        sender = users_by_id.get(request.sender_id)
        receiver = users_by_id.get(request.receiver_id)
        if not sender or not receiver:
            logger.warning(
                "Skipping friend request %s because a related user is missing (sender=%s receiver=%s)",
                request.id,
                request.sender_id,
                request.receiver_id,
            )
            return None
        return FriendRequestPublic(
            id=request.id,
            sender=to_social_user(sender),
            receiver=to_social_user(receiver),
            status=request.status,
            created_at=request.created_at,
            updated_at=request.updated_at,
        )

    incoming_payloads = [
        payload for payload in (serialize_request(request) for request in incoming) if payload
    ]
    outgoing_payloads = [
        payload for payload in (serialize_request(request) for request in outgoing) if payload
    ]

    return FriendRequestsBundle(
        incoming=incoming_payloads,
        outgoing=outgoing_payloads,
    )


@router.post(
    "/requests",
    response_model=FriendRequestPublic,
    status_code=status.HTTP_201_CREATED,
)
def send_friend_request(
    payload: FriendRequestCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    receiver_id = payload.receiver_id
    if receiver_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot add yourself."
        )

    receiver = db.get(User, receiver_id)
    if not receiver:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found."
        )

    existing_friendship = get_friendship_between(db, current_user.id, receiver_id)
    if existing_friendship:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You are already friends with this user.",
        )

    pending_request = db.scalar(
        select(FriendRequest).where(
            FriendRequest.status == "pending",
            or_(
                and_(
                    FriendRequest.sender_id == current_user.id,
                    FriendRequest.receiver_id == receiver_id,
                ),
                and_(
                    FriendRequest.sender_id == receiver_id,
                    FriendRequest.receiver_id == current_user.id,
                ),
            ),
        )
    )
    if pending_request:
        if pending_request.sender_id == current_user.id:
            detail = "Friend request already sent."
        else:
            detail = "This user has already sent you a friend request."
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)

    friend_request = FriendRequest(
        sender_id=current_user.id,
        receiver_id=receiver_id,
        status="pending",
    )
    db.add(friend_request)

    create_notification(
        db,
        user_id=receiver_id,
        notification_type="new_friend_request",
        title=f"{current_user.username} sent a friend request",
        body="Open Social Arena to accept or decline.",
        related_user_id=current_user.id,
    )

    db.commit()

    deliver_session_notifications(db)
    db.refresh(friend_request)

    return FriendRequestPublic(
        id=friend_request.id,
        sender=to_social_user(current_user),
        receiver=to_social_user(receiver),
        status=friend_request.status,
        created_at=friend_request.created_at,
        updated_at=friend_request.updated_at,
    )


@router.post("/requests/{request_id}/cancel", response_model=ActionResponse)
def cancel_friend_request(
    request_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    friend_request = db.get(FriendRequest, request_id)
    if not friend_request:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Friend request not found.",
        )

    if friend_request.sender_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not allowed to cancel this request.",
        )
    if friend_request.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only pending requests can be canceled.",
        )

    friend_request.status = "canceled"
    friend_request.updated_at = now_utc()
    db.commit()
    deliver_session_notifications(db)
    return ActionResponse(detail="Friend request canceled.")


@router.post("/requests/{request_id}/accept", response_model=ActionResponse)
def accept_friend_request(
    request_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    friend_request = db.get(FriendRequest, request_id)
    if not friend_request:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Friend request not found.",
        )

    if friend_request.receiver_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not allowed to accept this request.",
        )
    if friend_request.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only pending requests can be accepted.",
        )

    if not get_friendship_between(db, friend_request.sender_id, friend_request.receiver_id):
        low, high = ordered_pair(friend_request.sender_id, friend_request.receiver_id)
        db.add(Friendship(user_one_id=low, user_two_id=high))

    friend_request.status = "accepted"
    friend_request.updated_at = now_utc()

    sender = db.get(User, friend_request.sender_id)
    if sender:
        create_notification(
            db,
            user_id=friend_request.sender_id,
            notification_type="friend_request_accepted",
            title=f"{current_user.username} accepted your friend request",
            body="You can now message and challenge each other.",
            related_user_id=current_user.id,
        )

    db.commit()

    deliver_session_notifications(db)
    return ActionResponse(detail="Friend request accepted.")


@router.post("/requests/{request_id}/decline", response_model=ActionResponse)
def decline_friend_request(
    request_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    friend_request = db.get(FriendRequest, request_id)
    if not friend_request:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Friend request not found.",
        )

    if friend_request.receiver_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not allowed to decline this request.",
        )
    if friend_request.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only pending requests can be declined.",
        )

    friend_request.status = "declined"
    friend_request.updated_at = now_utc()
    db.commit()
    deliver_session_notifications(db)
    return ActionResponse(detail="Friend request declined.")


@router.delete("/friends/{friend_id}", response_model=ActionResponse)
def remove_friend(
    friend_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if friend_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid friend id."
        )

    friendship = get_friendship_between(db, current_user.id, friend_id)
    if not friendship:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Friendship not found."
        )

    db.delete(friendship)
    db.commit()
    deliver_session_notifications(db)
    return ActionResponse(detail="Friend removed.")


@router.get("/conversations", response_model=ConversationListResponse)
def list_conversations(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    conversation_ids = db.scalars(
        select(ConversationParticipant.conversation_id).where(
            ConversationParticipant.user_id == current_user.id
        )
    ).all()

    unique_conversation_ids = list(set(conversation_ids))
    expire_pending_challenges(db, conversation_ids=unique_conversation_ids)
    expire_stale_calls(db, conversation_ids=unique_conversation_ids)

    conversations, total_unread = load_conversation_payloads(
        db, current_user, unique_conversation_ids
    )
    return ConversationListResponse(conversations=conversations, total_unread=total_unread)


@router.post("/conversations/direct", response_model=ConversationPublic)
def create_or_get_direct_conversation(
    payload: ConversationCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    friend_id = payload.friend_id
    if friend_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot message yourself.",
        )

    friend = db.get(User, friend_id)
    if not friend:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="User not found."
        )

    friendship = get_friendship_between(db, current_user.id, friend_id)
    if not friendship:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only start conversations with friends.",
        )

    conversation = ensure_direct_conversation_between(db, current_user.id, friend_id)
    if conversation.id is None:
        db.commit()
        deliver_session_notifications(db)
        db.refresh(conversation)
    else:
        db.commit()
        deliver_session_notifications(db)

    payloads, _ = load_conversation_payloads(db, current_user, [conversation.id])
    if not payloads:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Unable to prepare conversation payload.",
        )
    return payloads[0]


@router.get(
    "/conversations/{conversation_id}/messages",
    response_model=ConversationMessagesResponse,
)
def list_messages(
    conversation_id: int,
    limit: int = Query(default=60, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_conversation_participant(db, conversation_id, current_user.id)
    expire_pending_challenges(db, conversation_ids=[conversation_id])
    expire_stale_calls(db, conversation_ids=[conversation_id])

    payloads, _ = load_conversation_payloads(db, current_user, [conversation_id])
    if not payloads:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Conversation not found."
        )

    message_rows = db.scalars(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at.desc(), Message.id.desc())
        .limit(limit)
    ).all()
    ordered_messages = list(reversed(message_rows))
    voice_map = get_voice_map_for_messages(db, [message.id for message in ordered_messages])
    messages = [to_message_public(message, voice_map) for message in ordered_messages]

    challenge_rows = list(
        reversed(
            db.scalars(
                select(Challenge)
                .where(Challenge.conversation_id == conversation_id)
                .order_by(Challenge.created_at.desc(), Challenge.id.desc())
                .limit(limit)
            ).all()
        )
    )
    challenge_user_ids = {
        challenge.challenger_id for challenge in challenge_rows
    } | {challenge.challenged_id for challenge in challenge_rows}
    challenge_users_by_id = get_users_map(db, challenge_user_ids)

    challenge_payloads = [
        to_challenge_public(challenge, current_user, challenge_users_by_id)
        for challenge in challenge_rows
    ]
    challenges_by_id = {challenge.id: challenge for challenge in challenge_payloads}

    timeline: list[ConversationTimelineItem] = []
    for message in messages:
        timeline.append(
            ConversationTimelineItem(
                id=f"message-{message.id}",
                kind=message.kind,
                created_at=message.created_at,
                message=message,
            )
        )
    for challenge in challenge_payloads:
        timeline.append(
            ConversationTimelineItem(
                id=f"challenge-{challenge.id}",
                kind="challenge",
                created_at=challenge.created_at,
                challenge=challenges_by_id[challenge.id],
            )
        )

    timeline.sort(key=lambda item: (item.created_at, item.id))
    if len(timeline) > limit:
        timeline = timeline[-limit:]

    return ConversationMessagesResponse(
        conversation=payloads[0],
        messages=messages,
        challenges=challenge_payloads,
        timeline=timeline,
    )


@router.post(
    "/conversations/{conversation_id}/messages",
    response_model=MessagePublic,
    status_code=status.HTTP_201_CREATED,
)
def send_message(
    conversation_id: int,
    payload: MessageSendRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conversation = assert_conversation_participant(db, conversation_id, current_user.id)

    if conversation.type != "direct":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only direct conversations are supported.",
        )

    body = payload.body.strip()
    if not body:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Message cannot be empty.",
        )

    peer_id = get_direct_peer_id(db, conversation_id, current_user.id)
    if not get_friendship_between(db, current_user.id, peer_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only message friends.",
        )

    message = Message(
        conversation_id=conversation_id,
        sender_id=current_user.id,
        body=body,
        is_seen=False,
    )
    conversation.updated_at = now_utc()
    db.add(message)
    db.flush()

    create_notification(
        db,
        user_id=peer_id,
        notification_type="new_message",
        title=f"New message from {current_user.username}",
        body=body[:110],
        related_user_id=current_user.id,
        related_conversation_id=conversation_id,
        metadata={"message_id": message.id},
    )

    db.commit()

    deliver_session_notifications(db)
    db.refresh(message)
    return to_message_public(message)


@router.post(
    "/conversations/{conversation_id}/voice-messages",
    response_model=MessagePublic,
    status_code=status.HTTP_201_CREATED,
)
def send_voice_message(
    conversation_id: int,
    audio: UploadFile = File(...),
    duration_seconds: int | None = Form(default=None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    conversation = assert_conversation_participant(db, conversation_id, current_user.id)

    if conversation.type != "direct":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Voice messages are only supported in direct conversations.",
        )

    peer_id = get_direct_peer_id(db, conversation_id, current_user.id)
    if not get_friendship_between(db, current_user.id, peer_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only send voice messages to friends.",
        )

    mime_type = normalize_audio_mime_type(audio.content_type)

    stored_relative_path: str | None = None
    try:
        payload = audio.file.read()
        if not payload:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Audio payload is empty.",
            )

        payload_size = len(payload)
        if payload_size > MAX_VOICE_FILE_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Voice message is too large.",
            )

        normalized_duration = (
            max(0, int(duration_seconds))
            if duration_seconds is not None
            else None
        )

        message = Message(
            conversation_id=conversation_id,
            sender_id=current_user.id,
            body=VOICE_PREVIEW_LABEL,
            is_seen=False,
        )
        conversation.updated_at = now_utc()
        db.add(message)
        db.flush()

        storage_path, public_url = save_voice_file(
            conversation_id=conversation_id,
            filename=audio.filename,
            mime_type=mime_type,
            payload=payload,
        )
        stored_relative_path = storage_path

        voice_message = VoiceMessage(
            message_id=message.id,
            conversation_id=conversation_id,
            sender_id=current_user.id,
            storage_path=storage_path,
            public_url=public_url,
            mime_type=mime_type,
            duration_seconds=normalized_duration,
            file_size_bytes=payload_size,
        )
        db.add(voice_message)
        db.flush()

        create_notification(
            db,
            user_id=peer_id,
            notification_type="new_voice_message",
            title=f"Voice message from {current_user.username}",
            body=build_voice_preview_label(normalized_duration),
            related_user_id=current_user.id,
            related_conversation_id=conversation_id,
            metadata={"message_id": message.id, "kind": "voice"},
        )

        db.commit()

        deliver_session_notifications(db)
        db.refresh(message)
        return to_message_public(message, {message.id: voice_message})
    except HTTPException:
        db.rollback()
        db.info.pop("pending_realtime_notifications", None)
        if stored_relative_path:
            stored_path = MEDIA_ROOT / stored_relative_path
            if stored_path.exists():
                stored_path.unlink(missing_ok=True)
        raise
    except OSError as exc:
        db.rollback()
        db.info.pop("pending_realtime_notifications", None)
        if stored_relative_path:
            stored_path = MEDIA_ROOT / stored_relative_path
            if stored_path.exists():
                stored_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Unable to store voice message file.",
        ) from exc
    except Exception as exc:
        db.rollback()
        db.info.pop("pending_realtime_notifications", None)
        if stored_relative_path:
            stored_path = MEDIA_ROOT / stored_relative_path
            if stored_path.exists():
                stored_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Unable to send voice message.",
        ) from exc
    finally:
        audio.file.close()


def create_challenge_record(
    *,
    db: Session,
    conversation_id: int,
    challenged_id: int,
    payload: ChallengeCreateRequest,
    current_user: User,
) -> ChallengePublic:
    conversation = assert_conversation_participant(db, conversation_id, current_user.id)
    if conversation.type != "direct":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Challenges are only supported in direct conversations.",
        )

    expire_pending_challenges(db, conversation_ids=[conversation_id])

    challenged_id = get_direct_peer_id(db, conversation_id, current_user.id)
    if challenged_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot challenge yourself.",
        )

    if not get_friendship_between(db, current_user.id, challenged_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only challenge friends.",
        )

    now = now_utc()
    pending_duplicate = db.scalar(
        select(Challenge).where(
            Challenge.conversation_id == conversation_id,
            Challenge.status == "pending",
            or_(
                and_(
                    Challenge.challenger_id == current_user.id,
                    Challenge.challenged_id == challenged_id,
                ),
                and_(
                    Challenge.challenger_id == challenged_id,
                    Challenge.challenged_id == current_user.id,
                ),
            ),
            or_(Challenge.expires_at.is_(None), Challenge.expires_at > now),
        )
    )
    if pending_duplicate:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A pending challenge already exists in this conversation.",
        )

    challenge_type = normalize_challenge_type(payload.challenge_type)
    title = challenge_title_for_type(challenge_type, payload.title)
    category = payload.category.strip() if payload.category else None
    difficulty = payload.difficulty.strip() if payload.difficulty else None
    expires_at = (
        now + timedelta(minutes=payload.expires_in_minutes)
        if payload.expires_in_minutes
        else None
    )

    challenge = Challenge(
        conversation_id=conversation_id,
        challenger_id=current_user.id,
        challenged_id=challenged_id,
        title=title,
        challenge_type=challenge_type,
        status="pending",
        category=category,
        difficulty=difficulty,
        expires_at=expires_at,
    )
    conversation.updated_at = now
    db.add(challenge)
    db.flush()

    challenged_user = db.get(User, challenged_id)
    if challenged_user:
        create_notification(
            db,
            user_id=challenged_id,
            notification_type="challenge_received",
            title=f"{current_user.username} challenged you",
            body=title,
            related_user_id=current_user.id,
            related_conversation_id=conversation_id,
            related_challenge_id=challenge.id,
            metadata={
                "category": category,
                "difficulty": difficulty,
                "challenge_type": challenge_type,
            },
        )

    db.commit()

    deliver_session_notifications(db)
    db.refresh(challenge)

    users_by_id = get_users_map(db, {current_user.id, challenged_id})
    return to_challenge_public(challenge, current_user, users_by_id)


@router.post("/challenges", response_model=ChallengePublic, status_code=status.HTTP_201_CREATED)
def create_direct_challenge(
    payload: ChallengeCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    opponent_id = payload.opponent_id
    if opponent_id is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="opponent_id is required.",
        )
    if opponent_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot challenge yourself.",
        )

    opponent = db.get(User, opponent_id)
    if not opponent:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found.",
        )

    if not get_friendship_between(db, current_user.id, opponent_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only challenge friends.",
        )

    conversation = ensure_direct_conversation_between(db, current_user.id, opponent_id)
    db.commit()
    deliver_session_notifications(db)
    db.refresh(conversation)
    return create_challenge_record(
        db=db,
        conversation_id=conversation.id,
        challenged_id=opponent_id,
        payload=payload,
        current_user=current_user,
    )


@router.post(
    "/conversations/{conversation_id}/challenges",
    response_model=ChallengePublic,
    status_code=status.HTTP_201_CREATED,
)
def create_challenge(
    conversation_id: int,
    payload: ChallengeCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    challenged_id = get_direct_peer_id(db, conversation_id, current_user.id)
    return create_challenge_record(
        db=db,
        conversation_id=conversation_id,
        challenged_id=challenged_id,
        payload=payload,
        current_user=current_user,
    )


@router.get(
    "/conversations/{conversation_id}/challenges",
    response_model=list[ChallengePublic],
)
def list_conversation_challenges(
    conversation_id: int,
    limit: int = Query(default=60, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_conversation_participant(db, conversation_id, current_user.id)
    expire_pending_challenges(db, conversation_ids=[conversation_id])

    challenge_rows = list(
        reversed(
            db.scalars(
                select(Challenge)
                .where(Challenge.conversation_id == conversation_id)
                .order_by(Challenge.created_at.desc(), Challenge.id.desc())
                .limit(limit)
            ).all()
        )
    )
    user_ids = {current_user.id}
    user_ids.update({challenge.challenger_id for challenge in challenge_rows})
    user_ids.update({challenge.challenged_id for challenge in challenge_rows})
    users_by_id = get_users_map(db, user_ids)

    return [
        to_challenge_public(challenge, current_user, users_by_id)
        for challenge in challenge_rows
    ]


def serialize_challenge_rows(
    db: Session, current_user: User, challenge_rows: list[Challenge]
) -> list[ChallengePublic]:
    if not challenge_rows:
        return []
    user_ids = {current_user.id}
    user_ids.update({challenge.challenger_id for challenge in challenge_rows})
    user_ids.update({challenge.challenged_id for challenge in challenge_rows})
    users_by_id = get_users_map(db, user_ids)
    return [
        to_challenge_public(challenge, current_user, users_by_id)
        for challenge in challenge_rows
    ]


@router.get("/challenges", response_model=list[ChallengePublic])
def list_my_challenges(
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=60, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    expire_pending_challenges(db)
    query = select(Challenge).where(
        or_(
            Challenge.challenger_id == current_user.id,
            Challenge.challenged_id == current_user.id,
        )
    )
    if status_filter == "incoming":
        query = query.where(Challenge.challenged_id == current_user.id)
    elif status_filter == "outgoing":
        query = query.where(Challenge.challenger_id == current_user.id)
    elif status_filter == "completed":
        query = query.where(Challenge.status == "completed")
    elif status_filter:
        query = query.where(Challenge.status == status_filter)

    challenge_rows = db.scalars(
        query.order_by(Challenge.updated_at.desc(), Challenge.id.desc()).limit(limit)
    ).all()
    return serialize_challenge_rows(db, current_user, challenge_rows)


@router.get("/challenges/incoming", response_model=list[ChallengePublic])
def list_incoming_challenges(
    limit: int = Query(default=60, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    expire_pending_challenges(db)
    challenge_rows = db.scalars(
        select(Challenge)
        .where(Challenge.challenged_id == current_user.id)
        .order_by(Challenge.updated_at.desc(), Challenge.id.desc())
        .limit(limit)
    ).all()
    return serialize_challenge_rows(db, current_user, challenge_rows)


@router.get("/challenges/outgoing", response_model=list[ChallengePublic])
def list_outgoing_challenges(
    limit: int = Query(default=60, ge=1, le=200),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    expire_pending_challenges(db)
    challenge_rows = db.scalars(
        select(Challenge)
        .where(Challenge.challenger_id == current_user.id)
        .order_by(Challenge.updated_at.desc(), Challenge.id.desc())
        .limit(limit)
    ).all()
    return serialize_challenge_rows(db, current_user, challenge_rows)


@router.get("/challenges/{challenge_id}", response_model=ChallengePublic)
def get_challenge(
    challenge_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    challenge = get_challenge_for_actor(db, challenge_id, current_user)
    users_by_id = get_users_map(db, {challenge.challenger_id, challenge.challenged_id})
    return to_challenge_public(challenge, current_user, users_by_id)


def _resolve_challenge_with_transition_guard(
    *,
    db: Session,
    challenge: Challenge,
    current_user: User,
    expected_actor: str,
) -> None:
    now = now_utc()
    if challenge.status == "pending" and has_reached(challenge.expires_at, now):
        challenge.status = "expired"
        challenge.responded_at = now
        challenge.updated_at = now
        conversation = db.get(Conversation, challenge.conversation_id)
        if conversation:
            conversation.updated_at = now
        db.commit()
        deliver_session_notifications(db)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Challenge expired.",
        )

    if challenge.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Challenge is already {challenge.status}.",
        )

    if expected_actor == "challenged" and challenge.challenged_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the challenged user can perform this action.",
        )

    if expected_actor == "challenger" and challenge.challenger_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the challenger can perform this action.",
        )


@router.patch("/challenges/{challenge_id}/accept", response_model=ChallengePublic)
@router.post("/challenges/{challenge_id}/accept", response_model=ChallengePublic)
def accept_challenge(
    challenge_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    challenge = get_challenge_for_actor(db, challenge_id, current_user)
    _resolve_challenge_with_transition_guard(
        db=db, challenge=challenge, current_user=current_user, expected_actor="challenged"
    )

    if not get_friendship_between(db, challenge.challenger_id, challenge.challenged_id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Challenge cannot be accepted because you are no longer friends.",
        )

    resolved_at = now_utc()
    challenge.status = "accepted"
    challenge.responded_at = resolved_at
    challenge.updated_at = resolved_at

    conversation = db.get(Conversation, challenge.conversation_id)
    if conversation:
        conversation.updated_at = resolved_at

    create_notification(
        db,
        user_id=challenge.challenger_id,
        notification_type="challenge_accepted",
        title=f"{current_user.username} accepted your challenge",
        body=challenge.title,
        related_user_id=current_user.id,
        related_conversation_id=challenge.conversation_id,
        related_challenge_id=challenge.id,
    )

    db.commit()

    deliver_session_notifications(db)
    db.refresh(challenge)

    users_by_id = get_users_map(db, {challenge.challenger_id, challenge.challenged_id})
    return to_challenge_public(challenge, current_user, users_by_id)


@router.patch("/challenges/{challenge_id}/decline", response_model=ChallengePublic)
@router.post("/challenges/{challenge_id}/decline", response_model=ChallengePublic)
def decline_challenge(
    challenge_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    challenge = get_challenge_for_actor(db, challenge_id, current_user)
    _resolve_challenge_with_transition_guard(
        db=db, challenge=challenge, current_user=current_user, expected_actor="challenged"
    )

    resolved_at = now_utc()
    challenge.status = "declined"
    challenge.responded_at = resolved_at
    challenge.updated_at = resolved_at

    conversation = db.get(Conversation, challenge.conversation_id)
    if conversation:
        conversation.updated_at = resolved_at

    create_notification(
        db,
        user_id=challenge.challenger_id,
        notification_type="challenge_declined",
        title=f"{current_user.username} declined your challenge",
        body=challenge.title,
        related_user_id=current_user.id,
        related_conversation_id=challenge.conversation_id,
        related_challenge_id=challenge.id,
    )

    db.commit()

    deliver_session_notifications(db)
    db.refresh(challenge)

    users_by_id = get_users_map(db, {challenge.challenger_id, challenge.challenged_id})
    return to_challenge_public(challenge, current_user, users_by_id)


@router.post("/challenges/{challenge_id}/cancel", response_model=ChallengePublic)
def cancel_challenge(
    challenge_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    challenge = get_challenge_for_actor(db, challenge_id, current_user)
    _resolve_challenge_with_transition_guard(
        db=db, challenge=challenge, current_user=current_user, expected_actor="challenger"
    )

    resolved_at = now_utc()
    challenge.status = "canceled"
    challenge.responded_at = resolved_at
    challenge.updated_at = resolved_at

    conversation = db.get(Conversation, challenge.conversation_id)
    if conversation:
        conversation.updated_at = resolved_at

    create_notification(
        db,
        user_id=challenge.challenged_id,
        notification_type="challenge_canceled",
        title=f"{current_user.username} canceled a challenge",
        body=challenge.title,
        related_user_id=current_user.id,
        related_conversation_id=challenge.conversation_id,
        related_challenge_id=challenge.id,
    )

    db.commit()

    deliver_session_notifications(db)
    db.refresh(challenge)

    users_by_id = get_users_map(db, {challenge.challenger_id, challenge.challenged_id})
    return to_challenge_public(challenge, current_user, users_by_id)


def challenge_timing_payload(challenge: Challenge) -> tuple[int, int, int]:
    question_count = CHALLENGE_QUESTION_COUNT
    per_question_seconds = CHALLENGE_PER_QUESTION_SECONDS
    total_time_seconds = question_count * per_question_seconds
    return question_count, per_question_seconds, total_time_seconds


@router.post("/challenges/{challenge_id}/start", response_model=ChallengeStartResponse)
def start_challenge(
    challenge_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    challenge = get_challenge_for_actor(db, challenge_id, current_user)
    if challenge.status == "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Accept the challenge before starting.",
        )
    if challenge.status not in {"accepted", "completed"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Challenge cannot be started while {challenge.status}.",
        )

    metadata = parse_challenge_metadata(challenge)
    question_count, per_question_seconds, total_time_seconds = challenge_timing_payload(challenge)
    gameplay = metadata.get("gameplay") if isinstance(metadata.get("gameplay"), dict) else {}
    gameplay.update(
        {
            "question_count": question_count,
            "per_question_time_seconds": per_question_seconds,
            "total_time_seconds": total_time_seconds,
            "challenge_type": normalize_challenge_type(challenge.challenge_type),
            "category": challenge.category,
            "difficulty": challenge.difficulty,
        }
    )
    metadata["gameplay"] = gameplay

    if challenge.started_at is None:
        challenge.started_at = now_utc()
    challenge.updated_at = now_utc()
    conversation = db.get(Conversation, challenge.conversation_id)
    if conversation:
        conversation.updated_at = challenge.updated_at
    save_challenge_metadata(challenge, metadata)
    db.commit()
    db.refresh(challenge)
    users_by_id = get_users_map(db, {challenge.challenger_id, challenge.challenged_id})
    return ChallengeStartResponse(
        challenge=to_challenge_public(challenge, current_user, users_by_id),
        question_count=question_count,
        total_time_seconds=total_time_seconds,
        per_question_time_seconds=per_question_seconds,
    )


def build_challenge_result_summary(
    challenge: Challenge,
    *,
    challenger_user: User | None,
    challenged_user: User | None,
) -> str:
    if challenge.challenger_score is None or challenge.challenged_score is None:
        waiting_user = challenged_user if challenge.challenger_score is not None else challenger_user
        waiting_name = waiting_user.username if waiting_user else "your opponent"
        return f"Waiting for {waiting_name} to finish."
    if challenge.winner_id == challenge.challenger_id and challenger_user:
        return (
            f"{challenger_user.username} won {challenge.challenger_score}-{challenge.challenged_score}."
        )
    if challenge.winner_id == challenge.challenged_id and challenged_user:
        return (
            f"{challenged_user.username} won {challenge.challenged_score}-{challenge.challenger_score}."
        )
    return f"Draw at {challenge.challenger_score}-{challenge.challenged_score}."


@router.post("/challenges/{challenge_id}/submit", response_model=ChallengeSubmitResponse)
def submit_challenge_result(
    challenge_id: int,
    payload: ChallengeSubmitRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    challenge = get_challenge_for_actor(db, challenge_id, current_user)
    if challenge.status == "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Accept the challenge before submitting results.",
        )
    if challenge.status not in {"accepted", "completed"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Challenge cannot be submitted while {challenge.status}.",
        )

    metadata = parse_challenge_metadata(challenge)
    role_key = "challenger" if current_user.id == challenge.challenger_id else "challenged"
    result_key = f"{role_key}_result"
    if isinstance(metadata.get(result_key), dict):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You have already submitted this challenge.",
        )

    submitted_at = now_utc()
    metadata[result_key] = {
        "user_id": current_user.id,
        "score": payload.score,
        "correct_answers": payload.correct_answers,
        "total_questions": payload.total_questions,
        "accuracy": payload.accuracy,
        "lemons_earned": payload.lemons_earned,
        "xp_gained": payload.xp_gained,
        "submitted_at": submitted_at.isoformat(),
    }

    if challenge.started_at is None:
        challenge.started_at = submitted_at

    if current_user.id == challenge.challenger_id:
        challenge.challenger_score = payload.score
    else:
        challenge.challenged_score = payload.score

    challenger_user = db.get(User, challenge.challenger_id)
    challenged_user = db.get(User, challenge.challenged_id)
    challenger_result = metadata.get("challenger_result") if isinstance(metadata.get("challenger_result"), dict) else None
    challenged_result = metadata.get("challenged_result") if isinstance(metadata.get("challenged_result"), dict) else None

    if challenger_result and challenged_result:
        challenge.status = "completed"
        challenge.completed_at = submitted_at
        challenge.responded_at = challenge.responded_at or submitted_at
        challenger_accuracy = int(challenger_result.get("accuracy") or 0)
        challenged_accuracy = int(challenged_result.get("accuracy") or 0)
        if (challenge.challenger_score or 0) > (challenge.challenged_score or 0):
            challenge.winner_id = challenge.challenger_id
        elif (challenge.challenged_score or 0) > (challenge.challenger_score or 0):
            challenge.winner_id = challenge.challenged_id
        elif challenger_accuracy > challenged_accuracy:
            challenge.winner_id = challenge.challenger_id
        elif challenged_accuracy > challenger_accuracy:
            challenge.winner_id = challenge.challenged_id
        else:
            challenge.winner_id = None

        create_notification(
            db,
            user_id=challenge.challenger_id,
            notification_type="challenge_result",
            title="Challenge completed",
            body=challenge.title,
            related_user_id=challenge.challenged_id,
            related_conversation_id=challenge.conversation_id,
            related_challenge_id=challenge.id,
        )
        create_notification(
            db,
            user_id=challenge.challenged_id,
            notification_type="challenge_result",
            title="Challenge completed",
            body=challenge.title,
            related_user_id=challenge.challenger_id,
            related_conversation_id=challenge.conversation_id,
            related_challenge_id=challenge.id,
        )
    else:
        challenge.status = "accepted"

    challenge.updated_at = submitted_at
    challenge.result_summary = build_challenge_result_summary(
        challenge,
        challenger_user=challenger_user,
        challenged_user=challenged_user,
    )
    save_challenge_metadata(challenge, metadata)

    conversation = db.get(Conversation, challenge.conversation_id)
    if conversation:
        conversation.updated_at = submitted_at

    db.commit()
    deliver_session_notifications(db)
    db.refresh(challenge)
    users_by_id = get_users_map(db, {challenge.challenger_id, challenge.challenged_id})
    serialized = to_challenge_public(challenge, current_user, users_by_id)
    return ChallengeSubmitResponse(
        challenge=serialized,
        submitted=True,
        waiting_for_opponent=serialized.awaiting_opponent_result,
    )


@router.post("/challenges/{challenge_id}/rematch", response_model=ChallengePublic, status_code=status.HTTP_201_CREATED)
def rematch_challenge(
    challenge_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    original = get_challenge_for_actor(db, challenge_id, current_user)
    if original.status not in {"completed", "declined", "expired", "canceled"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Rematch is available after a resolved challenge.",
        )

    opponent_id = original.challenged_id if current_user.id == original.challenger_id else original.challenger_id
    if not get_friendship_between(db, current_user.id, opponent_id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You can only rematch friends.",
        )

    rematch_payload = ChallengeCreateRequest(
        title=f"Rematch · {challenge_title_for_type(normalize_challenge_type(original.challenge_type))}",
        challenge_type=normalize_challenge_type(original.challenge_type),
        category=original.category,
        difficulty=original.difficulty,
        expires_in_minutes=1440,
    )
    return create_challenge_record(
        db=db,
        conversation_id=original.conversation_id,
        challenged_id=opponent_id,
        payload=rematch_payload,
        current_user=current_user,
    )


def _serialize_call_for_current(db: Session, call: CallSession, current_user: User) -> CallPublic:
    users_by_id = get_users_map(db, {call.caller_id, call.callee_id})
    return to_call_public(call, current_user, users_by_id)


@router.get(
    "/conversations/{conversation_id}/calls/latest",
    response_model=CallPublic | None,
)
def get_latest_conversation_call(
    conversation_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_call_session_table(db)
    assert_conversation_participant(db, conversation_id, current_user.id)
    expire_stale_calls(db, conversation_ids=[conversation_id])

    latest_call = get_latest_call_for_conversation(db, conversation_id, current_user)
    if not latest_call:
        return None
    return _serialize_call_for_current(db, latest_call, current_user)


@router.get("/calls/incoming", response_model=list[CallPublic])
def list_incoming_calls(
    limit: int = Query(default=10, ge=1, le=30),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_call_session_table(db)
    expire_stale_calls(db)
    calls = db.scalars(
        select(CallSession)
        .where(
            CallSession.callee_id == current_user.id,
            CallSession.status.in_(("ringing", "connecting", "active")),
        )
        .order_by(CallSession.updated_at.desc(), CallSession.id.desc())
        .limit(limit)
    ).all()
    return [_serialize_call_for_current(db, call, current_user) for call in calls]


@router.post(
    "/conversations/{conversation_id}/calls/start",
    response_model=CallPublic,
    status_code=status.HTTP_201_CREATED,
)
def start_call(
    conversation_id: int,
    payload: CallCreateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ensure_call_session_table(db)
    conversation = assert_conversation_participant(db, conversation_id, current_user.id)
    if conversation.type != "direct":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Calls are only supported in direct conversations.",
        )

    expire_stale_calls(db)

    callee_id = get_direct_peer_id(db, conversation_id, current_user.id)
    if callee_id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot call yourself.",
        )

    if not get_friendship_between(db, current_user.id, callee_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only call friends.",
        )

    user_busy_call = db.scalar(
        select(CallSession)
        .where(
            CallSession.status.in_(tuple(CALL_ACTIVE_STATUSES)),
            or_(
                CallSession.caller_id == current_user.id,
                CallSession.callee_id == current_user.id,
                CallSession.caller_id == callee_id,
                CallSession.callee_id == callee_id,
            ),
        )
        .order_by(CallSession.created_at.desc(), CallSession.id.desc())
    )
    if user_busy_call:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A call is already active for one of the participants.",
        )

    active_call = db.scalar(
        select(CallSession)
        .where(
            CallSession.conversation_id == conversation_id,
            CallSession.status.in_(tuple(CALL_ACTIVE_STATUSES)),
        )
        .order_by(CallSession.created_at.desc(), CallSession.id.desc())
    )
    if active_call:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A call is already in progress for this conversation.",
        )

    normalized_offer = normalize_session_description(
        extract_offer_payload(payload),
        expected_type="offer",
        field_name="offer_sdp",
    )
    logger.info(
        "Backend received offer for conversation %s from user %s (%s chars, starts_v0=%s): %s",
        conversation_id,
        current_user.id,
        len(normalized_offer),
        normalized_offer.startswith("v=0"),
        sdp_preview(normalized_offer, max_chars=120),
    )

    started_at = now_utc()
    call = CallSession(
        conversation_id=conversation_id,
        caller_id=current_user.id,
        callee_id=callee_id,
        status="ringing",
        offer_sdp=normalized_offer,
    )
    conversation.updated_at = started_at
    db.add(call)
    db.flush()
    logger.info(
        "Call %s started by user %s in conversation %s to callee %s",
        call.id,
        current_user.id,
        conversation_id,
        callee_id,
    )

    create_notification(
        db,
        user_id=callee_id,
        notification_type="call_incoming",
        title=f"Incoming call from {current_user.username}",
        body="Voice call request in Social Arena.",
        related_user_id=current_user.id,
        related_conversation_id=conversation_id,
        metadata={"call_id": call.id},
    )

    db.commit()

    deliver_session_notifications(db)
    db.refresh(call)
    return _serialize_call_for_current(db, call, current_user)


@router.post("/calls/{call_id}/accept", response_model=CallPublic)
def accept_call(
    call_id: int,
    payload: CallAcceptRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = get_call_for_actor(db, call_id, current_user)
    if expire_single_call_if_needed(db, call):
        db.refresh(call)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Call was missed.",
        )

    if current_user.id != call.callee_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the called user can accept this call.",
        )
    if call.status in {"connecting", "active"} and call.answer_sdp:
        logger.info("Call %s accept replay by user %s", call.id, current_user.id)
        return _serialize_call_for_current(db, call, current_user)
    if call.status != "ringing":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Call is already {call.status}.",
        )

    if not get_friendship_between(db, call.caller_id, call.callee_id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Call cannot be accepted because you are no longer friends.",
        )

    answer_sdp = normalize_session_description(
        extract_answer_payload(payload),
        expected_type="answer",
        field_name="answer_sdp",
    )
    logger.info(
        "Backend received answer for call %s from user %s (%s chars, starts_v0=%s): %s",
        call.id,
        current_user.id,
        len(answer_sdp),
        answer_sdp.startswith("v=0"),
        sdp_preview(answer_sdp, max_chars=120),
    )

    accepted_at = now_utc()
    call.answer_sdp = answer_sdp
    call.status = "connecting"
    call.updated_at = accepted_at
    conversation = db.get(Conversation, call.conversation_id)
    if conversation:
        conversation.updated_at = accepted_at
    logger.info("Call %s accepted by user %s", call.id, current_user.id)

    create_notification(
        db,
        user_id=call.caller_id,
        notification_type="call_accepted",
        title=f"{current_user.username} accepted your call",
        body="Connecting voice call...",
        related_user_id=current_user.id,
        related_conversation_id=call.conversation_id,
        metadata={"call_id": call.id},
    )

    db.commit()

    deliver_session_notifications(db)
    db.refresh(call)
    return _serialize_call_for_current(db, call, current_user)


@router.post("/calls/{call_id}/decline", response_model=CallPublic)
def decline_call(
    call_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = get_call_for_actor(db, call_id, current_user)
    if expire_single_call_if_needed(db, call):
        db.refresh(call)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Call was missed.",
        )

    if current_user.id != call.callee_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the called user can decline this call.",
        )
    if call.status in CALL_TERMINAL_STATUSES:
        logger.info("Call %s decline replay by user %s with status %s", call.id, current_user.id, call.status)
        return _serialize_call_for_current(db, call, current_user)
    if call.status not in {"ringing", "connecting"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Call is already {call.status}.",
        )

    declined_at = now_utc()
    finalize_call_status(
        db,
        call=call,
        status_value="declined",
        actor_user_id=current_user.id,
        ended_at=declined_at,
        create_event=True,
    )

    create_notification(
        db,
        user_id=call.caller_id,
        notification_type="call_declined",
        title=f"{current_user.username} declined your call",
        body="Call request declined.",
        related_user_id=current_user.id,
        related_conversation_id=call.conversation_id,
        metadata={"call_id": call.id},
    )

    db.commit()

    deliver_session_notifications(db)
    db.refresh(call)
    return _serialize_call_for_current(db, call, current_user)


@router.post("/calls/{call_id}/cancel", response_model=CallPublic)
def cancel_call(
    call_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = get_call_for_actor(db, call_id, current_user)
    if expire_single_call_if_needed(db, call):
        db.refresh(call)
        return _serialize_call_for_current(db, call, current_user)

    if current_user.id != call.caller_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the caller can cancel this call.",
        )
    if call.status in CALL_TERMINAL_STATUSES:
        logger.info("Call %s cancel replay by user %s with status %s", call.id, current_user.id, call.status)
        return _serialize_call_for_current(db, call, current_user)
    if call.status not in {"ringing", "connecting"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Call is already {call.status}.",
        )

    canceled_at = now_utc()
    next_status = "missed" if call.status == "ringing" else "canceled"
    finalize_call_status(
        db,
        call=call,
        status_value=next_status,
        actor_user_id=current_user.id,
        ended_at=canceled_at,
        create_event=True,
        event_note="Caller canceled",
    )

    create_notification(
        db,
        user_id=call.callee_id,
        notification_type="call_missed" if next_status == "missed" else "call_canceled",
        title="Missed call" if next_status == "missed" else "Call canceled",
        body=(
            f"Missed call from {current_user.username}"
            if next_status == "missed"
            else f"{current_user.username} canceled the call"
        ),
        related_user_id=current_user.id,
        related_conversation_id=call.conversation_id,
        metadata={"call_id": call.id},
    )

    db.commit()

    deliver_session_notifications(db)
    db.refresh(call)
    return _serialize_call_for_current(db, call, current_user)


@router.post("/calls/{call_id}/activate", response_model=CallPublic)
def activate_call(
    call_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = get_call_for_actor(db, call_id, current_user)
    if expire_single_call_if_needed(db, call):
        db.refresh(call)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Call was missed.",
        )

    if call.status in CALL_TERMINAL_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Call is already {call.status}.",
        )

    if call.status == "ringing":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Call has not been accepted yet.",
        )

    activated_at = now_utc()
    call.status = "active"
    if not call.connected_at:
        call.connected_at = activated_at
    call.updated_at = activated_at

    conversation = db.get(Conversation, call.conversation_id)
    if conversation:
        conversation.updated_at = activated_at

    db.commit()

    deliver_session_notifications(db)
    db.refresh(call)
    return _serialize_call_for_current(db, call, current_user)


@router.post("/calls/{call_id}/end", response_model=CallPublic)
def end_call(
    call_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = get_call_for_actor(db, call_id, current_user)
    if expire_single_call_if_needed(db, call):
        db.refresh(call)
        return _serialize_call_for_current(db, call, current_user)

    if call.status in CALL_TERMINAL_STATUSES:
        return _serialize_call_for_current(db, call, current_user)

    ended_at = now_utc()
    if call.status == "ringing":
        next_status = "missed"
    elif call.status == "connecting":
        next_status = "canceled"
    else:
        next_status = "ended"

    finalize_call_status(
        db,
        call=call,
        status_value=next_status,
        actor_user_id=current_user.id,
        ended_at=ended_at,
        create_event=True,
    )

    other_user_id = call.callee_id if current_user.id == call.caller_id else call.caller_id
    if next_status in {"missed", "canceled"}:
        create_notification(
            db,
            user_id=other_user_id,
            notification_type="call_missed" if next_status == "missed" else "call_canceled",
            title="Missed call" if next_status == "missed" else "Call ended",
            body=(
                f"Missed call from {current_user.username}"
                if next_status == "missed"
                else f"Call ended by {current_user.username}"
            ),
            related_user_id=current_user.id,
            related_conversation_id=call.conversation_id,
            metadata={"call_id": call.id},
        )

    db.commit()

    deliver_session_notifications(db)
    db.refresh(call)
    return _serialize_call_for_current(db, call, current_user)


@router.post("/calls/{call_id}/candidates", response_model=CallPublic)
def add_call_candidate(
    call_id: int,
    payload: CallIceCandidateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    call = get_call_for_actor(db, call_id, current_user)
    if call.status in CALL_TERMINAL_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Call is already {call.status}.",
        )

    candidate_payload = normalize_ice_candidate_payload(payload.candidate)
    logger.info(
        "Signaling candidate received for call %s from user %s: %s",
        call.id,
        current_user.id,
        json.dumps(candidate_payload, ensure_ascii=True, separators=(",", ":"))[:320],
    )

    if current_user.id == call.caller_id:
        call.caller_candidates_json = append_candidate_json(
            call.caller_candidates_json,
            candidate_payload,
        )
    elif current_user.id == call.callee_id:
        call.callee_candidates_json = append_candidate_json(
            call.callee_candidates_json,
            candidate_payload,
        )
    else:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not allowed to update this call.",
        )

    call.updated_at = now_utc()
    db.commit()
    deliver_session_notifications(db)
    db.refresh(call)
    return _serialize_call_for_current(db, call, current_user)


@router.post(
    "/conversations/{conversation_id}/messages/seen",
    response_model=MarkSeenResponse,
)
def mark_messages_seen(
    conversation_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_conversation_participant(db, conversation_id, current_user.id)

    seen_at = now_utc()
    result = db.execute(
        update(Message)
        .where(
            Message.conversation_id == conversation_id,
            Message.sender_id != current_user.id,
            Message.is_seen.is_(False),
        )
        .values(is_seen=True, seen_at=seen_at, updated_at=seen_at)
    )
    db.commit()
    deliver_session_notifications(db)

    updated_count = max(0, int(result.rowcount or 0))
    return MarkSeenResponse(updated=updated_count)


@router.get("/conversations/unread-count", response_model=UnreadCountResponse)
def get_unread_count(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    unread_total = db.scalar(
        select(func.count(Message.id))
        .join(
            ConversationParticipant,
            ConversationParticipant.conversation_id == Message.conversation_id,
        )
        .where(
            ConversationParticipant.user_id == current_user.id,
            Message.sender_id != current_user.id,
            Message.is_seen.is_(False),
        )
    )
    return UnreadCountResponse(total_unread=int(unread_total or 0))


@router.get("/notifications", response_model=NotificationListResponse)
def list_notifications(
    limit: int = Query(default=30, ge=1, le=100),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = db.scalars(
        select(Notification)
        .where(Notification.user_id == current_user.id)
        .order_by(Notification.created_at.desc(), Notification.id.desc())
        .limit(limit)
    ).all()

    related_user_ids = {
        notification.related_user_id
        for notification in rows
        if notification.related_user_id
    }
    users_by_id = get_users_map(db, related_user_ids)

    unread_total = db.scalar(
        select(func.count(Notification.id)).where(
            Notification.user_id == current_user.id,
            Notification.is_read.is_(False),
        )
    )

    return NotificationListResponse(
        notifications=[
            to_notification_public(notification, users_by_id) for notification in rows
        ],
        total_unread=int(unread_total or 0),
    )


@router.get(
    "/notifications/unread-count",
    response_model=NotificationUnreadCountResponse,
)
def get_notification_unread_count(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    unread_total = db.scalar(
        select(func.count(Notification.id)).where(
            Notification.user_id == current_user.id,
            Notification.is_read.is_(False),
        )
    )
    return NotificationUnreadCountResponse(unread_count=int(unread_total or 0))


@router.post("/notifications/{notification_id}/read", response_model=ActionResponse)
def mark_notification_read(
    notification_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    notification = db.get(Notification, notification_id)
    if not notification or notification.user_id != current_user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found."
        )

    if not notification.is_read:
        notification.is_read = True
        notification.updated_at = now_utc()
        db.commit()
        deliver_session_notifications(db)
        deliver_unread_count_realtime(db, current_user.id)

    return ActionResponse(detail="Notification marked as read.")


@router.post("/notifications/read-all", response_model=MarkAllReadResponse)
def mark_all_notifications_read(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    marked_at = now_utc()
    result = db.execute(
        update(Notification)
        .where(
            Notification.user_id == current_user.id,
            Notification.is_read.is_(False),
        )
        .values(is_read=True, updated_at=marked_at)
    )
    db.commit()
    deliver_session_notifications(db)
    deliver_unread_count_realtime(db, current_user.id)

    return MarkAllReadResponse(updated=max(0, int(result.rowcount or 0)))
