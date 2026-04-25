import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.social import Challenge, FriendRequest, Friendship, Notification
from app.models.user import User, UserStatsSnapshot
from app.schemas.profile import (
    AchievementPublic,
    PublicRelationshipState,
    RecentActivityItem,
    UserActivityResponse,
    UserProfilePrivate,
    UserProfilePublic,
    UserProfileUpdate,
    UserStatsPublic,
    UserStatsSnapshotUpdate,
)


router = APIRouter(prefix="/users", tags=["users"])

XP_PER_LEVEL = 300
MAX_ACTIVITY_ITEMS = 12


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def safe_display_name(user: User) -> str:
    if isinstance(user.display_name, str) and user.display_name.strip():
        return user.display_name.strip()
    return user.username


def parse_json_object(payload: str | None) -> dict:
    if not payload:
        return {}
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def parse_activity_items(payload: str | None) -> list[RecentActivityItem]:
    if not payload:
        return []
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    items: list[RecentActivityItem] = []
    for entry in parsed[:MAX_ACTIVITY_ITEMS]:
        if not isinstance(entry, dict):
            continue
        try:
            items.append(RecentActivityItem.model_validate(entry))
        except Exception:
            continue
    return items


def serialize_activity_items(items: list[RecentActivityItem]) -> str | None:
    safe_items = [item.model_dump(mode="json") for item in items[:MAX_ACTIVITY_ITEMS]]
    return json.dumps(safe_items, separators=(",", ":")) if safe_items else None


def get_or_create_stats_snapshot(db: Session, user_id: int) -> UserStatsSnapshot:
    snapshot = db.scalar(select(UserStatsSnapshot).where(UserStatsSnapshot.user_id == user_id))
    if snapshot:
        return snapshot
    snapshot = UserStatsSnapshot(user_id=user_id)
    db.add(snapshot)
    db.flush()
    return snapshot


def relationship_state_for_user(
    db: Session, *, viewer: User, target: User
) -> PublicRelationshipState | None:
    if viewer.id == target.id:
        return None

    friendship = db.scalar(
        select(Friendship).where(
            or_(
                and_(Friendship.user_one_id == viewer.id, Friendship.user_two_id == target.id),
                and_(Friendship.user_one_id == target.id, Friendship.user_two_id == viewer.id),
            )
        )
    )
    if friendship:
        return PublicRelationshipState(
            relationship_status="friend", request_id=None, can_message=True, can_challenge=True
        )

    pending_request = db.scalar(
        select(FriendRequest).where(
            FriendRequest.status == "pending",
            or_(
                and_(FriendRequest.sender_id == viewer.id, FriendRequest.receiver_id == target.id),
                and_(FriendRequest.sender_id == target.id, FriendRequest.receiver_id == viewer.id),
            ),
        )
    )
    if not pending_request:
        return PublicRelationshipState()

    if pending_request.sender_id == viewer.id:
        return PublicRelationshipState(
            relationship_status="outgoing_request",
            request_id=pending_request.id,
            can_message=False,
            can_challenge=False,
        )
    return PublicRelationshipState(
        relationship_status="incoming_request",
        request_id=pending_request.id,
        can_message=False,
        can_challenge=False,
    )


def build_profile_public(
    db: Session, *, target: User, viewer: User | None, include_private: bool
) -> UserProfilePublic | UserProfilePrivate:
    relationship = relationship_state_for_user(db, viewer=viewer, target=target) if viewer else None
    base_payload = {
        "id": target.id,
        "username": target.username,
        "display_name": safe_display_name(target),
        "bio": target.bio,
        "avatar_url": target.avatar_url,
        "joined_at": target.created_at,
        "relationship": relationship,
    }
    if include_private:
        return UserProfilePrivate(email=target.email, **base_payload)
    return UserProfilePublic(**base_payload)


def compute_rank(db: Session, snapshot: UserStatsSnapshot) -> int | None:
    if snapshot.total_points <= 0 and snapshot.total_lemons <= 0:
        return None

    higher_count = db.scalar(
        select(func.count(UserStatsSnapshot.id)).where(
            or_(
                UserStatsSnapshot.total_points > snapshot.total_points,
                and_(
                    UserStatsSnapshot.total_points == snapshot.total_points,
                    UserStatsSnapshot.total_lemons > snapshot.total_lemons,
                ),
                and_(
                    UserStatsSnapshot.total_points == snapshot.total_points,
                    UserStatsSnapshot.total_lemons == snapshot.total_lemons,
                    UserStatsSnapshot.user_id < snapshot.user_id,
                ),
            )
        )
    )
    return int(higher_count or 0) + 1


def compute_achievements(
    db: Session, *, user: User, snapshot: UserStatsSnapshot, rank: int | None
) -> list[AchievementPublic]:
    friendship_count = int(
        db.scalar(
            select(func.count(Friendship.id)).where(
                or_(Friendship.user_one_id == user.id, Friendship.user_two_id == user.id)
            )
        )
        or 0
    )
    challenge_count = int(
        db.scalar(
            select(func.count(Challenge.id)).where(
                or_(Challenge.challenger_id == user.id, Challenge.challenged_id == user.id)
            )
        )
        or 0
    )
    accuracy = (
        round((snapshot.total_correct_answers / snapshot.total_questions_answered) * 100)
        if snapshot.total_questions_answered
        else 0
    )

    definitions = [
        (
            "first_quiz",
            "First Quiz",
            "Complete your first quiz round.",
            snapshot.quizzes_played,
            1,
        ),
        (
            "ten_quizzes",
            "10 Quizzes Played",
            "Stay active long enough to complete ten quiz rounds.",
            snapshot.quizzes_played,
            10,
        ),
        (
            "hundred_correct",
            "100 Correct Answers",
            "Reach one hundred correct answers across all rounds.",
            snapshot.total_correct_answers,
            100,
        ),
        (
            "seven_day_streak",
            "7-Day Streak",
            "Keep your learning streak alive for seven sessions.",
            snapshot.best_streak,
            7,
        ),
        (
            "first_friend",
            "First Friend",
            "Add your first friend in Social Arena.",
            friendship_count,
            1,
        ),
        (
            "first_challenge",
            "First Challenge",
            "Send or receive your first challenge.",
            challenge_count,
            1,
        ),
        (
            "top_ten",
            "Top 10 Leaderboard",
            "Reach the top ten active players by total points.",
            10 if rank and rank <= 10 else (rank or 9999),
            10,
        ),
    ]

    achievements: list[AchievementPublic] = []
    for achievement_id, label, description, current, target in definitions:
      unlocked = current >= target if achievement_id != "top_ten" else bool(rank and rank <= 10)
      achievements.append(
          AchievementPublic(
              id=achievement_id,
              label=label,
              description=description,
              current=min(current, target) if achievement_id == "top_ten" and unlocked else current,
              target=target,
              unlocked=unlocked,
          )
      )

    bonus_accuracy = AchievementPublic(
        id="sharp_accuracy",
        label="80% Accuracy",
        description="Maintain 80% accuracy across your answered questions.",
        current=accuracy,
        target=80,
        unlocked=accuracy >= 80 and snapshot.quizzes_played >= 3,
    )
    achievements.insert(3, bonus_accuracy)
    return achievements


def build_stats_public(db: Session, *, user: User, snapshot: UserStatsSnapshot) -> UserStatsPublic:
    accuracy = (
        round((snapshot.total_correct_answers / snapshot.total_questions_answered) * 100)
        if snapshot.total_questions_answered
        else 0
    )
    xp = max(0, snapshot.total_points)
    level = xp // XP_PER_LEVEL + 1
    xp_into_level = xp % XP_PER_LEVEL
    rank = compute_rank(db, snapshot)
    recent_activity = parse_activity_items(snapshot.recent_activity_json)
    category_counts = parse_json_object(snapshot.category_counts_json)
    favorite_category = None
    categories_explored = 0
    if category_counts:
        categories_explored = len([key for key, value in category_counts.items() if int(value or 0) > 0])
        sorted_categories = sorted(
            (
                (str(key), int(value or 0))
                for key, value in category_counts.items()
                if str(key).strip() and int(value or 0) > 0
            ),
            key=lambda item: (-item[1], item[0].lower()),
        )
        if sorted_categories:
            favorite_category = sorted_categories[0][0]
    achievements = compute_achievements(db, user=user, snapshot=snapshot, rank=rank)

    return UserStatsPublic(
        user_id=user.id,
        level=level,
        xp=xp,
        xp_into_level=xp_into_level,
        xp_for_next_level=XP_PER_LEVEL,
        lemons_balance=max(0, snapshot.total_lemons),
        streak=max(0, snapshot.current_streak),
        best_streak=max(0, snapshot.best_streak),
        total_points=max(0, snapshot.total_points),
        quizzes_played=max(0, snapshot.quizzes_played),
        quizzes_won=max(0, snapshot.quizzes_won),
        correct_answers=max(0, snapshot.total_correct_answers),
        total_questions_answered=max(0, snapshot.total_questions_answered),
        accuracy_percentage=max(0, min(100, accuracy)),
        favorite_category=favorite_category,
        categories_explored=categories_explored,
        rank=rank,
        recent_activity=recent_activity,
        achievements=achievements,
    )


def create_notification(
    db: Session,
    *,
    user_id: int,
    notification_type: str,
    title: str,
    message: str,
    metadata: dict | None = None,
) -> None:
    notification = Notification(
        user_id=user_id,
        type=notification_type,
        title=title[:140],
        body=message[:320],
        metadata_json=json.dumps(metadata, separators=(",", ":")) if metadata else None,
    )
    db.add(notification)


@router.get("/me", response_model=UserProfilePrivate)
def get_my_profile(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    return build_profile_public(db, target=current_user, viewer=current_user, include_private=True)


@router.patch("/me", response_model=UserProfilePrivate)
def update_my_profile(
    payload: UserProfileUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    normalized_username = payload.username.strip()
    normalized_display_name = payload.display_name.strip()
    normalized_bio = payload.bio.strip() if isinstance(payload.bio, str) else None
    normalized_avatar_url = payload.avatar_url.strip() if isinstance(payload.avatar_url, str) else None

    existing_username = db.scalar(
        select(User).where(User.username == normalized_username, User.id != current_user.id)
    )
    if existing_username:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Username is already taken."
        )

    current_user.username = normalized_username
    current_user.display_name = normalized_display_name
    current_user.bio = normalized_bio or None
    current_user.avatar_url = normalized_avatar_url or None
    db.commit()
    db.refresh(current_user)
    return build_profile_public(db, target=current_user, viewer=current_user, include_private=True)


@router.get("/me/stats", response_model=UserStatsPublic)
def get_my_stats(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    snapshot = get_or_create_stats_snapshot(db, current_user.id)
    db.commit()
    db.refresh(snapshot)
    return build_stats_public(db, user=current_user, snapshot=snapshot)


@router.put("/me/stats", response_model=UserStatsPublic)
def sync_my_stats(
    payload: UserStatsSnapshotUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    snapshot = get_or_create_stats_snapshot(db, current_user.id)
    previous_quizzes_played = snapshot.quizzes_played
    previous_achievement_ids = {
        achievement.id
        for achievement in compute_achievements(
            db,
            user=current_user,
            snapshot=snapshot,
            rank=compute_rank(db, snapshot),
        )
        if achievement.unlocked
    }

    snapshot.quizzes_played = payload.quizzes_played
    snapshot.quizzes_won = payload.quizzes_won
    snapshot.total_points = payload.total_points
    snapshot.total_lemons = payload.total_lemons
    snapshot.total_correct_answers = payload.total_correct_answers
    snapshot.total_questions_answered = payload.total_questions_answered
    snapshot.current_streak = payload.current_streak
    snapshot.best_streak = payload.best_streak
    snapshot.category_counts_json = json.dumps(payload.category_counts, separators=(",", ":"))
    snapshot.recent_activity_json = serialize_activity_items(payload.recent_activity)
    snapshot.updated_at = now_utc()
    db.flush()

    rank = compute_rank(db, snapshot)
    current_achievements = compute_achievements(
        db, user=current_user, snapshot=snapshot, rank=rank
    )
    unlocked_now = {achievement.id for achievement in current_achievements if achievement.unlocked}

    if payload.quizzes_played > previous_quizzes_played and payload.recent_activity:
        latest = payload.recent_activity[0]
        create_notification(
            db,
            user_id=current_user.id,
            notification_type="quiz_result",
            title="Quiz result recorded",
            message=latest.title,
            metadata={"type": latest.type, "created_at": latest.created_at.isoformat()},
        )

    for achievement in current_achievements:
        if achievement.unlocked and achievement.id not in previous_achievement_ids:
            create_notification(
                db,
                user_id=current_user.id,
                notification_type="achievement_unlocked",
                title=f"Achievement unlocked: {achievement.label}",
                message=achievement.description,
                metadata={"achievement_id": achievement.id},
            )

    db.commit()
    db.refresh(snapshot)
    return build_stats_public(db, user=current_user, snapshot=snapshot)


@router.get("/me/activity", response_model=UserActivityResponse)
def get_my_activity(
    current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    snapshot = get_or_create_stats_snapshot(db, current_user.id)
    return UserActivityResponse(items=parse_activity_items(snapshot.recent_activity_json))


@router.get("/{user_id}", response_model=UserProfilePublic)
def get_public_profile(
    user_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    return build_profile_public(db, target=target, viewer=current_user, include_private=False)


@router.get("/{user_id}/stats", response_model=UserStatsPublic)
def get_public_stats(
    user_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    snapshot = get_or_create_stats_snapshot(db, target.id)
    db.commit()
    db.refresh(snapshot)
    return build_stats_public(db, user=target, snapshot=snapshot)


@router.get("/{user_id}/activity", response_model=UserActivityResponse)
def get_public_activity(
    user_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    target = db.get(User, user_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found.")
    snapshot = get_or_create_stats_snapshot(db, target.id)
    return UserActivityResponse(items=parse_activity_items(snapshot.recent_activity_json))
