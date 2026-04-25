from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class SocialUserPublic(BaseModel):
    id: int
    username: str
    display_name: str
    email: str | None = None

    model_config = ConfigDict(from_attributes=True)


class UserSearchResult(BaseModel):
    user: SocialUserPublic
    relationship_status: str
    request_id: int | None = None


class FriendRequestCreate(BaseModel):
    receiver_id: int = Field(gt=0)


class FriendRequestPublic(BaseModel):
    id: int
    sender: SocialUserPublic
    receiver: SocialUserPublic
    status: str
    created_at: datetime
    updated_at: datetime


class FriendRequestsBundle(BaseModel):
    incoming: list[FriendRequestPublic]
    outgoing: list[FriendRequestPublic]


class FriendshipPublic(BaseModel):
    id: int
    friend: SocialUserPublic
    created_at: datetime


class ConversationCreateRequest(BaseModel):
    friend_id: int = Field(gt=0)


class MessagePreview(BaseModel):
    id: int
    body: str
    sender_id: int
    created_at: datetime
    is_seen: bool
    kind: str = "message"
    voice_duration_seconds: int | None = None


class ConversationPublic(BaseModel):
    id: int
    peer: SocialUserPublic
    created_at: datetime
    updated_at: datetime
    can_message: bool
    unread_count: int
    last_message: MessagePreview | None = None


class ConversationListResponse(BaseModel):
    conversations: list[ConversationPublic]
    total_unread: int


class MessageSendRequest(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


class VoiceAttachmentPublic(BaseModel):
    url: str
    duration_seconds: int | None = None
    mime_type: str
    file_size_bytes: int


class MessagePublic(BaseModel):
    id: int
    conversation_id: int
    sender_id: int
    body: str
    kind: str = "text"
    voice: VoiceAttachmentPublic | None = None
    metadata: dict[str, Any] | None = None
    is_seen: bool
    seen_at: datetime | None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ChallengeCreateRequest(BaseModel):
    opponent_id: int | None = Field(default=None, gt=0)
    conversation_id: int | None = Field(default=None, gt=0)
    title: str | None = Field(default=None, min_length=3, max_length=140)
    challenge_type: Literal[
        "quick_quiz", "vocabulary", "grammar", "mixed"
    ] = "quick_quiz"
    category: str | None = Field(default=None, max_length=60)
    difficulty: str | None = Field(default=None, max_length=30)
    expires_in_minutes: int | None = Field(default=1440, ge=5, le=10080)


class ChallengePublic(BaseModel):
    id: int
    conversation_id: int
    challenger: SocialUserPublic
    challenged: SocialUserPublic
    title: str
    challenge_type: str
    status: str
    category: str | None = None
    difficulty: str | None = None
    challenger_score: int | None = None
    challenged_score: int | None = None
    winner_id: int | None = None
    started_at: datetime | None = None
    created_at: datetime
    updated_at: datetime
    responded_at: datetime | None = None
    expires_at: datetime | None = None
    completed_at: datetime | None = None
    result_summary: str | None = None
    metadata: dict[str, Any] | None = None
    is_expired: bool
    can_accept: bool
    can_decline: bool
    can_cancel: bool
    can_start: bool = False
    can_submit: bool = False
    can_view_result: bool = False
    can_rematch: bool = False
    is_actionable_by_current: bool
    awaiting_opponent_result: bool = False


class ChallengeStartResponse(BaseModel):
    challenge: ChallengePublic
    question_count: int
    total_time_seconds: int
    per_question_time_seconds: int | None = None


class ChallengeSubmitRequest(BaseModel):
    score: int = Field(ge=0)
    correct_answers: int = Field(ge=0)
    total_questions: int = Field(gt=0)
    accuracy: int = Field(ge=0, le=100)
    lemons_earned: int | None = Field(default=None, ge=0)
    xp_gained: int | None = Field(default=None, ge=0)


class ChallengeSubmitResponse(BaseModel):
    challenge: ChallengePublic
    submitted: bool
    waiting_for_opponent: bool


class SessionDescriptionPayload(BaseModel):
    type: Literal["offer", "answer"] | None = None
    sdp: str = Field(min_length=10, max_length=120000)


class CallCreateRequest(BaseModel):
    type: Literal["offer"] | None = None
    sdp: str | SessionDescriptionPayload | None = None
    offer_sdp: str | SessionDescriptionPayload | None = None


class CallAcceptRequest(BaseModel):
    type: Literal["answer"] | None = None
    sdp: str | SessionDescriptionPayload | None = None
    answer_sdp: str | SessionDescriptionPayload | None = None


class CallIceCandidateRequest(BaseModel):
    type: Literal["candidate"] | None = "candidate"
    candidate: dict[str, Any]


class CallPublic(BaseModel):
    id: int
    conversation_id: int
    caller: SocialUserPublic
    callee: SocialUserPublic
    status: str
    offer_sdp: SessionDescriptionPayload | None = None
    answer_sdp: SessionDescriptionPayload | None = None
    caller_candidates: list[dict[str, Any]] = Field(default_factory=list)
    callee_candidates: list[dict[str, Any]] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    connected_at: datetime | None = None
    ended_at: datetime | None = None
    duration_seconds: int | None = None
    is_outgoing: bool
    is_incoming: bool
    can_accept: bool
    can_decline: bool
    can_cancel: bool
    can_end: bool


class ConversationTimelineItem(BaseModel):
    id: str
    kind: str
    created_at: datetime
    message: MessagePublic | None = None
    challenge: ChallengePublic | None = None


class ConversationMessagesResponse(BaseModel):
    conversation: ConversationPublic
    messages: list[MessagePublic]
    challenges: list[ChallengePublic] = Field(default_factory=list)
    timeline: list[ConversationTimelineItem] = Field(default_factory=list)


class NotificationPublic(BaseModel):
    id: int
    user_id: int
    type: str
    title: str
    body: str
    is_read: bool
    created_at: datetime
    related_user: SocialUserPublic | None = None
    related_conversation_id: int | None = None
    related_challenge_id: int | None = None
    metadata: dict[str, Any] | None = None


class NotificationListResponse(BaseModel):
    notifications: list[NotificationPublic]
    total_unread: int


class NotificationUnreadCountResponse(BaseModel):
    unread_count: int


class MarkSeenResponse(BaseModel):
    updated: int


class MarkAllReadResponse(BaseModel):
    updated: int


class UnreadCountResponse(BaseModel):
    total_unread: int


class ActionResponse(BaseModel):
    detail: str
