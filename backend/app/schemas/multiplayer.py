from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class MultiplayerActionResponse(BaseModel):
    detail: str


class CreateRoomRequest(BaseModel):
    title: str = Field(min_length=3, max_length=140)
    category: str = Field(min_length=3, max_length=60)
    difficulty: str = Field(min_length=3, max_length=30)
    question_count: int = Field(default=5, ge=3, le=10)
    max_players: int = Field(default=4, ge=2, le=12)


class JoinRoomByCodeRequest(BaseModel):
    room_code: str = Field(min_length=4, max_length=12)


class InvitePlayerRequest(BaseModel):
    friend_user_id: int = Field(ge=1)


class RoomUserPublic(BaseModel):
    id: int
    username: str
    display_name: str
    avatar_url: str | None = None

    model_config = ConfigDict(from_attributes=True)


class RoomPlayerPublic(BaseModel):
    id: int
    user_id: int
    is_host: bool
    is_ready: bool
    is_connected: bool
    score: int
    correct_answers: int
    answered_questions: int
    accuracy: int
    current_streak: int
    best_streak: int
    joined_at: datetime
    left_at: datetime | None = None
    user: RoomUserPublic


class RoomSummary(BaseModel):
    id: int
    room_code: str
    host_id: int | None = None
    title: str
    category: str
    difficulty: str
    question_count: int
    max_players: int
    status: str
    created_at: datetime
    started_at: datetime | None = None
    ended_at: datetime | None = None
    joined_players: int
    connected_players: int
    host: RoomUserPublic | None = None


class MultiplayerQuestionPublic(BaseModel):
    id: int
    question_number: int
    total_questions: int
    question_text: str
    options: list[str]
    category: str
    difficulty: str
    time_limit_seconds: int
    started_at: datetime | None = None
    ends_at: datetime | None = None
    remaining_seconds: int
    has_answered: bool


class LeaderboardEntry(BaseModel):
    player_id: int
    user_id: int
    username: str
    display_name: str
    avatar_url: str | None = None
    score: int
    correct_answers: int
    answered_questions: int
    accuracy: int
    is_host: bool
    rank: int


class QuestionRevealPlayerResult(BaseModel):
    player_id: int
    user_id: int
    score: int
    correct_answers: int
    answered_questions: int
    selected_option_index: int | None = None
    is_correct: bool
    points_awarded: int


class QuestionRevealPublic(BaseModel):
    question_id: int
    question_number: int
    total_questions: int
    correct_answer_index: int
    correct_option: str
    explanation: str | None = None
    revealed_at: datetime
    next_transition_at: datetime | None = None
    player_results: list[QuestionRevealPlayerResult]


class MultiplayerGameStatePublic(BaseModel):
    countdown_started_at: datetime | None = None
    countdown_ends_at: datetime | None = None
    current_question: MultiplayerQuestionPublic | None = None
    last_reveal: QuestionRevealPublic | None = None
    leaderboard: list[LeaderboardEntry] = Field(default_factory=list)
    question_duration_seconds: int
    reveal_duration_seconds: int


class PlayerResultPublic(BaseModel):
    player_id: int
    user_id: int
    username: str
    display_name: str
    avatar_url: str | None = None
    rank: int
    score: int
    correct_answers: int
    answered_questions: int
    accuracy: int
    lemons_earned: int
    xp_gained: int
    is_host: bool
    is_winner: bool


class RoomResultsPublic(BaseModel):
    room_id: int
    winner_user_id: int | None = None
    winner: RoomUserPublic | None = None
    rankings: list[PlayerResultPublic]
    total_questions: int
    completed_at: datetime | None = None


class RoomDetailResponse(BaseModel):
    room: RoomSummary
    players: list[RoomPlayerPublic]
    game: MultiplayerGameStatePublic
    results: RoomResultsPublic | None = None


class RoomListResponse(BaseModel):
    rooms: list[RoomSummary]
