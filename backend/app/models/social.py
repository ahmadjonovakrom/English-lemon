from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class FriendRequest(Base):
    __tablename__ = "friend_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    sender_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    receiver_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="pending", index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    sender = relationship("User", foreign_keys=[sender_id])
    receiver = relationship("User", foreign_keys=[receiver_id])

    __table_args__ = (
        CheckConstraint("sender_id <> receiver_id", name="ck_friend_request_not_self"),
        CheckConstraint(
            "status IN ('pending', 'accepted', 'declined', 'canceled')",
            name="ck_friend_request_status",
        ),
        Index(
            "ix_friend_requests_sender_receiver_status",
            "sender_id",
            "receiver_id",
            "status",
        ),
        Index(
            "ix_friend_requests_receiver_sender_status",
            "receiver_id",
            "sender_id",
            "status",
        ),
    )


class Friendship(Base):
    __tablename__ = "friendships"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_one_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    user_two_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    user_one = relationship("User", foreign_keys=[user_one_id])
    user_two = relationship("User", foreign_keys=[user_two_id])

    __table_args__ = (
        UniqueConstraint("user_one_id", "user_two_id", name="uq_friendship_pair"),
        CheckConstraint("user_one_id < user_two_id", name="ck_friendship_ordered_pair"),
        Index("ix_friendship_user_one", "user_one_id"),
        Index("ix_friendship_user_two", "user_two_id"),
    )


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    type: Mapped[str] = mapped_column(String(20), nullable=False, default="direct")
    direct_key: Mapped[str | None] = mapped_column(
        String(64), unique=True, nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    participants = relationship(
        "ConversationParticipant",
        back_populates="conversation",
        cascade="all, delete-orphan",
    )
    messages = relationship(
        "Message", back_populates="conversation", cascade="all, delete-orphan"
    )
    challenges = relationship(
        "Challenge", back_populates="conversation", cascade="all, delete-orphan"
    )
    calls = relationship(
        "CallSession", back_populates="conversation", cascade="all, delete-orphan"
    )

    __table_args__ = (
        CheckConstraint("type IN ('direct')", name="ck_conversation_type"),
        Index("ix_conversation_updated_at", "updated_at"),
    )


class ConversationParticipant(Base):
    __tablename__ = "conversation_participants"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    conversation = relationship("Conversation", back_populates="participants")
    user = relationship("User")

    __table_args__ = (
        UniqueConstraint(
            "conversation_id", "user_id", name="uq_conversation_participant_pair"
        ),
        Index("ix_conversation_participant_user", "user_id", "conversation_id"),
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sender_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    is_seen: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    conversation = relationship("Conversation", back_populates="messages")
    sender = relationship("User")
    voice = relationship(
        "VoiceMessage",
        back_populates="message",
        uselist=False,
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("ix_messages_conversation_created", "conversation_id", "created_at"),
        Index("ix_messages_conversation_seen", "conversation_id", "is_seen"),
    )


class Challenge(Base):
    __tablename__ = "challenges"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    challenger_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    challenged_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(140), nullable=False, default="Quick Quiz Challenge")
    challenge_type: Mapped[str] = mapped_column(
        String(40), nullable=False, default="quick_quiz", index=True
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending", index=True)
    category: Mapped[str | None] = mapped_column(String(60), nullable=True)
    difficulty: Mapped[str | None] = mapped_column(String(30), nullable=True)
    challenger_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    challenged_score: Mapped[int | None] = mapped_column(Integer, nullable=True)
    winner_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    metadata_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    conversation = relationship("Conversation", back_populates="challenges")
    challenger = relationship("User", foreign_keys=[challenger_id])
    challenged = relationship("User", foreign_keys=[challenged_id])
    winner = relationship("User", foreign_keys=[winner_id])

    __table_args__ = (
        CheckConstraint("challenger_id <> challenged_id", name="ck_challenge_not_self"),
        CheckConstraint(
            "status IN ('pending', 'accepted', 'declined', 'canceled', 'expired', 'completed')",
            name="ck_challenge_status",
        ),
        CheckConstraint(
            "challenger_score IS NULL OR challenger_score >= 0",
            name="ck_challenge_challenger_score_non_negative",
        ),
        CheckConstraint(
            "challenged_score IS NULL OR challenged_score >= 0",
            name="ck_challenge_challenged_score_non_negative",
        ),
        Index("ix_challenges_conversation_status", "conversation_id", "status", "created_at"),
        Index("ix_challenges_challenged_status", "challenged_id", "status", "created_at"),
        Index("ix_challenges_challenger_status", "challenger_id", "status", "created_at"),
    )


class CallSession(Base):
    __tablename__ = "call_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    caller_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    callee_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="ringing", index=True)
    offer_sdp: Mapped[str | None] = mapped_column(Text, nullable=True)
    answer_sdp: Mapped[str | None] = mapped_column(Text, nullable=True)
    caller_candidates_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    callee_candidates_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    connected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    conversation = relationship("Conversation", back_populates="calls")
    caller = relationship("User", foreign_keys=[caller_id])
    callee = relationship("User", foreign_keys=[callee_id])

    __table_args__ = (
        CheckConstraint("caller_id <> callee_id", name="ck_call_session_not_self"),
        CheckConstraint(
            "status IN ('ringing', 'connecting', 'active', 'ended', 'declined', 'missed', 'canceled')",
            name="ck_call_session_status",
        ),
        CheckConstraint(
            "duration_seconds IS NULL OR duration_seconds >= 0",
            name="ck_call_session_duration_non_negative",
        ),
        Index(
            "ix_call_sessions_conversation_created",
            "conversation_id",
            "created_at",
        ),
        Index(
            "ix_call_sessions_callee_status_updated",
            "callee_id",
            "status",
            "updated_at",
        ),
        Index(
            "ix_call_sessions_caller_status_updated",
            "caller_id",
            "status",
            "updated_at",
        ),
    )


class VoiceMessage(Base):
    __tablename__ = "voice_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    message_id: Mapped[int] = mapped_column(
        ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, unique=True, index=True
    )
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sender_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    storage_path: Mapped[str] = mapped_column(String(600), nullable=False)
    public_url: Mapped[str] = mapped_column(String(600), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(120), nullable=False, default="audio/webm")
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    file_size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    message = relationship("Message", back_populates="voice")
    conversation = relationship("Conversation")
    sender = relationship("User")

    __table_args__ = (
        CheckConstraint("file_size_bytes > 0", name="ck_voice_message_file_size_positive"),
        CheckConstraint(
            "duration_seconds IS NULL OR duration_seconds >= 0",
            name="ck_voice_message_duration_non_negative",
        ),
        Index("ix_voice_messages_conversation_created", "conversation_id", "created_at"),
    )


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(140), nullable=False)
    body: Mapped[str] = mapped_column(String(320), nullable=False)
    is_read: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    related_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    related_conversation_id: Mapped[int | None] = mapped_column(
        ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    related_challenge_id: Mapped[int | None] = mapped_column(
        ForeignKey("challenges.id", ondelete="SET NULL"), nullable=True, index=True
    )
    metadata_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    user = relationship("User", foreign_keys=[user_id])
    related_user = relationship("User", foreign_keys=[related_user_id])
    related_conversation = relationship("Conversation", foreign_keys=[related_conversation_id])
    related_challenge = relationship("Challenge", foreign_keys=[related_challenge_id])

    __table_args__ = (
        CheckConstraint("length(type) > 0", name="ck_notification_type_not_empty"),
        Index("ix_notifications_user_created", "user_id", "created_at"),
        Index("ix_notifications_user_unread", "user_id", "is_read", "created_at"),
    )
