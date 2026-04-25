from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class UserProfileUpdate(BaseModel):
    display_name: str = Field(min_length=2, max_length=80)
    username: str = Field(min_length=3, max_length=50)
    bio: str | None = Field(default=None, max_length=240)
    avatar_url: str | None = Field(default=None, max_length=600)


class RecentActivityItem(BaseModel):
    type: str
    title: str
    subtitle: str | None = None
    created_at: datetime
    metadata: dict[str, Any] | None = None


class AchievementPublic(BaseModel):
    id: str
    label: str
    description: str
    current: int
    target: int
    unlocked: bool
    unlocked_at: datetime | None = None


class UserStatsSnapshotUpdate(BaseModel):
    quizzes_played: int = Field(ge=0, le=1_000_000)
    quizzes_won: int = Field(ge=0, le=1_000_000)
    total_points: int = Field(ge=0, le=100_000_000)
    total_lemons: int = Field(ge=0, le=100_000_000)
    total_correct_answers: int = Field(ge=0, le=100_000_000)
    total_questions_answered: int = Field(ge=0, le=100_000_000)
    current_streak: int = Field(ge=0, le=100_000)
    best_streak: int = Field(ge=0, le=100_000)
    category_counts: dict[str, int] = Field(default_factory=dict)
    recent_activity: list[RecentActivityItem] = Field(default_factory=list)


class PublicRelationshipState(BaseModel):
    relationship_status: str = "none"
    request_id: int | None = None
    can_message: bool = False
    can_challenge: bool = False


class UserProfilePublic(BaseModel):
    id: int
    username: str
    display_name: str
    bio: str | None = None
    avatar_url: str | None = None
    joined_at: datetime
    relationship: PublicRelationshipState | None = None

    model_config = ConfigDict(from_attributes=True)


class UserProfilePrivate(UserProfilePublic):
    email: EmailStr


class UserStatsPublic(BaseModel):
    user_id: int
    level: int
    xp: int
    xp_into_level: int
    xp_for_next_level: int
    lemons_balance: int
    streak: int
    best_streak: int
    total_points: int
    quizzes_played: int
    quizzes_won: int
    correct_answers: int
    total_questions_answered: int
    accuracy_percentage: int
    favorite_category: str | None = None
    categories_explored: int = 0
    rank: int | None = None
    recent_activity: list[RecentActivityItem] = Field(default_factory=list)
    achievements: list[AchievementPublic] = Field(default_factory=list)


class UserActivityResponse(BaseModel):
    items: list[RecentActivityItem] = Field(default_factory=list)
