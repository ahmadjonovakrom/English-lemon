from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class MultiplayerRoom(Base):
    __tablename__ = "multiplayer_rooms"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    room_code: Mapped[str] = mapped_column(String(8), unique=True, index=True, nullable=False)
    host_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(String(140), nullable=False)
    category: Mapped[str] = mapped_column(String(60), nullable=False, default="Mixed")
    difficulty: Mapped[str] = mapped_column(String(30), nullable=False, default="Medium")
    question_count: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    max_players: Mapped[int] = mapped_column(Integer, nullable=False, default=4)
    question_time_limit_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=18)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="waiting", index=True)
    current_question_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    winner_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    countdown_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    current_question_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    question_revealed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    host = relationship("User", foreign_keys=[host_id])
    winner = relationship("User", foreign_keys=[winner_user_id])
    players = relationship(
        "MultiplayerRoomPlayer",
        back_populates="room",
        cascade="all, delete-orphan",
        order_by="MultiplayerRoomPlayer.joined_at.asc()",
    )
    questions = relationship(
        "MultiplayerRoomQuestion",
        back_populates="room",
        cascade="all, delete-orphan",
        order_by="MultiplayerRoomQuestion.question_index.asc()",
    )


class MultiplayerRoomPlayer(Base):
    __tablename__ = "multiplayer_room_players"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    room_id: Mapped[int] = mapped_column(
        ForeignKey("multiplayer_rooms.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    is_host: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_ready: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_connected: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    score: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    correct_answers: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    answered_questions: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    current_streak: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    best_streak: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    room = relationship("MultiplayerRoom", back_populates="players")
    user = relationship("User")
    answers = relationship(
        "MultiplayerRoomAnswer",
        back_populates="player",
        cascade="all, delete-orphan",
    )

    __table_args__ = (UniqueConstraint("room_id", "user_id", name="uq_multiplayer_room_user"),)


class MultiplayerRoomQuestion(Base):
    __tablename__ = "multiplayer_room_questions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    room_id: Mapped[int] = mapped_column(
        ForeignKey("multiplayer_rooms.id", ondelete="CASCADE"), nullable=False, index=True
    )
    question_index: Mapped[int] = mapped_column(Integer, nullable=False)
    question_key: Mapped[str] = mapped_column(String(60), nullable=False)
    question_text: Mapped[str] = mapped_column(Text, nullable=False)
    options_json: Mapped[str] = mapped_column(Text, nullable=False)
    correct_answer_index: Mapped[int] = mapped_column(Integer, nullable=False)
    category: Mapped[str] = mapped_column(String(60), nullable=False)
    difficulty: Mapped[str] = mapped_column(String(30), nullable=False)
    explanation: Mapped[str | None] = mapped_column(Text, nullable=True)
    time_limit_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=18)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    room = relationship("MultiplayerRoom", back_populates="questions")
    answers = relationship(
        "MultiplayerRoomAnswer",
        back_populates="room_question",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        UniqueConstraint("room_id", "question_index", name="uq_multiplayer_room_question_index"),
    )


class MultiplayerRoomAnswer(Base):
    __tablename__ = "multiplayer_room_answers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    room_id: Mapped[int] = mapped_column(
        ForeignKey("multiplayer_rooms.id", ondelete="CASCADE"), nullable=False, index=True
    )
    room_question_id: Mapped[int] = mapped_column(
        ForeignKey("multiplayer_room_questions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    player_id: Mapped[int] = mapped_column(
        ForeignKey("multiplayer_room_players.id", ondelete="CASCADE"), nullable=False, index=True
    )
    selected_option_index: Mapped[int] = mapped_column(Integer, nullable=False)
    is_correct: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    points_awarded: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    response_time_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    answered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    room_question = relationship("MultiplayerRoomQuestion", back_populates="answers")
    player = relationship("MultiplayerRoomPlayer", back_populates="answers")

    __table_args__ = (
        UniqueConstraint(
            "room_question_id", "player_id", name="uq_multiplayer_room_question_player"
        ),
    )
