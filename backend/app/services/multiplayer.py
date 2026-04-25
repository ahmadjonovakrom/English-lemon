import asyncio
import json
import random
import string
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, WebSocket, status
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session, joinedload
from starlette.websockets import WebSocketState

from app.core.database import SessionLocal
from app.models.multiplayer import (
    MultiplayerRoom,
    MultiplayerRoomAnswer,
    MultiplayerRoomPlayer,
    MultiplayerRoomQuestion,
)
from app.models.social import Friendship, Notification
from app.models.user import User, UserStatsSnapshot
from app.schemas.multiplayer import RoomDetailResponse
from app.services.multiplayer_bank import QUIZ_BANK


ROOM_COUNTDOWN_SECONDS = 3
QUESTION_DURATION_SECONDS = 18
QUESTION_REVEAL_SECONDS = 4
BASE_POINTS = {"easy": 15, "medium": 25, "hard": 35}
ACTIVE_ROOM_STATUSES = {"waiting", "starting", "in_progress"}
TERMINAL_ROOM_STATUSES = {"completed", "cancelled"}


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def normalize_datetime(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def normalize_room_code(value: str) -> str:
    return "".join(ch for ch in str(value or "").upper() if ch.isalnum())[:8]


def safe_display_name(user: User) -> str:
    if isinstance(user.display_name, str) and user.display_name.strip():
        return user.display_name.strip()
    return user.username


def parse_json_list(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return []
    return [str(item) for item in parsed] if isinstance(parsed, list) else []


def serialize_json(value: object) -> str:
    return json.dumps(value, separators=(",", ":"))


def get_room_query():
    return select(MultiplayerRoom).options(
        joinedload(MultiplayerRoom.host),
        joinedload(MultiplayerRoom.winner),
        joinedload(MultiplayerRoom.players).joinedload(MultiplayerRoomPlayer.user),
        joinedload(MultiplayerRoom.questions).joinedload(MultiplayerRoomQuestion.answers),
    )


def get_room_or_404(db: Session, room_id: int) -> MultiplayerRoom:
    room = db.execute(get_room_query().where(MultiplayerRoom.id == room_id)).unique().scalar_one_or_none()
    if not room:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Room not found.")
    return room


def get_player_record(room: MultiplayerRoom, user_id: int) -> MultiplayerRoomPlayer | None:
    for player in room.players:
        if player.user_id == user_id:
            return player
    return None


def get_active_players(room: MultiplayerRoom) -> list[MultiplayerRoomPlayer]:
    return [player for player in room.players if player.left_at is None]


def get_connected_players(room: MultiplayerRoom) -> list[MultiplayerRoomPlayer]:
    return [player for player in get_active_players(room) if player.is_connected]


def get_playing_players(room: MultiplayerRoom) -> list[MultiplayerRoomPlayer]:
    return [player for player in get_active_players(room) if player.left_at is None]


def normalize_category(value: str) -> str:
    normalized = str(value or "").strip()
    return normalized if normalized else "Mixed"


def normalize_difficulty(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"easy", "medium", "hard"}:
        return normalized.title()
    if normalized in {"mixed", "intermediate", "advanced"}:
        return "Medium"
    return "Medium"


def pick_questions(category: str, difficulty: str, question_count: int) -> list[dict]:
    normalized_category = normalize_category(category)
    normalized_difficulty = normalize_difficulty(difficulty)

    pool = QUIZ_BANK
    if normalized_category.lower() != "mixed":
        pool = [item for item in pool if item["category"].lower() == normalized_category.lower()]
    if normalized_difficulty.lower() != "medium":
        pool = [item for item in pool if item["difficulty"].lower() == normalized_difficulty.lower()]

    if len(pool) < question_count:
        pool = QUIZ_BANK if len(QUIZ_BANK) >= question_count else pool

    if len(pool) < question_count:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Not enough questions available for this room setup.",
        )

    return random.sample(pool, question_count)


def generate_room_code(db: Session) -> str:
    while True:
        code = "".join(random.choices(string.ascii_uppercase + string.digits, k=6))
        existing = db.scalar(select(MultiplayerRoom.id).where(MultiplayerRoom.room_code == code))
        if not existing:
            return code


def base_points_for_difficulty(difficulty: str) -> int:
    return BASE_POINTS.get(str(difficulty or "").strip().lower(), 25)


def calculate_answer_points(question: MultiplayerRoomQuestion, response_time_ms: int, is_correct: bool) -> int:
    if not is_correct:
        return 0
    base_points = base_points_for_difficulty(question.difficulty)
    total_ms = max(1000, int(question.time_limit_seconds) * 1000)
    remaining_ratio = max(0.0, min(1.0, 1 - (response_time_ms / total_ms)))
    speed_bonus = int(round(remaining_ratio * 10))
    return base_points + speed_bonus


def get_room_current_question(room: MultiplayerRoom) -> MultiplayerRoomQuestion | None:
    if room.current_question_index is None:
        return None
    for question in room.questions:
        if question.question_index == room.current_question_index:
            return question
    return None


def get_answer_for_player(question: MultiplayerRoomQuestion, player_id: int) -> MultiplayerRoomAnswer | None:
    for answer in question.answers:
        if answer.player_id == player_id:
            return answer
    return None


def compute_accuracy(correct_answers: int, answered_questions: int) -> int:
    if answered_questions <= 0:
        return 0
    return round((correct_answers / answered_questions) * 100)


def leaderboard_entries(room: MultiplayerRoom) -> list[dict]:
    ranked = sorted(
        get_active_players(room),
        key=lambda player: (-player.score, -player.correct_answers, player.joined_at, player.user_id),
    )
    entries: list[dict] = []
    for index, player in enumerate(ranked, start=1):
        entries.append(
            {
                "player_id": player.id,
                "user_id": player.user_id,
                "username": player.user.username,
                "display_name": safe_display_name(player.user),
                "avatar_url": player.user.avatar_url,
                "score": player.score,
                "correct_answers": player.correct_answers,
                "answered_questions": player.answered_questions,
                "accuracy": compute_accuracy(player.correct_answers, player.answered_questions),
                "is_host": player.is_host,
                "rank": index,
            }
        )
    return entries


def serialize_room_user(user: User | None) -> dict | None:
    if not user:
        return None
    return {
        "id": user.id,
        "username": user.username,
        "display_name": safe_display_name(user),
        "avatar_url": user.avatar_url,
    }


def serialize_room_summary(room: MultiplayerRoom) -> dict:
    active_players = get_active_players(room)
    connected_players = get_connected_players(room)
    return {
        "id": room.id,
        "room_code": room.room_code,
        "host_id": room.host_id,
        "title": room.title,
        "category": room.category,
        "difficulty": room.difficulty,
        "question_count": room.question_count,
        "max_players": room.max_players,
        "status": room.status,
        "created_at": room.created_at,
        "started_at": room.started_at,
        "ended_at": room.ended_at,
        "joined_players": len(active_players),
        "connected_players": len(connected_players),
        "host": serialize_room_user(room.host),
    }


def serialize_room_player(player: MultiplayerRoomPlayer) -> dict:
    return {
        "id": player.id,
        "user_id": player.user_id,
        "is_host": player.is_host,
        "is_ready": player.is_ready,
        "is_connected": player.is_connected,
        "score": player.score,
        "correct_answers": player.correct_answers,
        "answered_questions": player.answered_questions,
        "accuracy": compute_accuracy(player.correct_answers, player.answered_questions),
        "current_streak": player.current_streak,
        "best_streak": player.best_streak,
        "joined_at": player.joined_at,
        "left_at": player.left_at,
        "user": serialize_room_user(player.user),
    }


def serialize_current_question(room: MultiplayerRoom, viewer_id: int | None = None) -> dict | None:
    question = get_room_current_question(room)
    if not question or room.status not in {"in_progress", "starting"}:
        return None
    if room.status == "starting" and room.current_question_started_at is None:
        return None

    started_at = normalize_datetime(room.current_question_started_at)
    ends_at = (
        started_at + timedelta(seconds=question.time_limit_seconds)
        if started_at
        else None
    )
    remaining_seconds = 0
    if ends_at:
        remaining_seconds = max(0, int((ends_at - now_utc()).total_seconds()))

    viewer_has_answered = False
    if viewer_id is not None:
        player = get_player_record(room, viewer_id)
        if player:
            viewer_has_answered = get_answer_for_player(question, player.id) is not None

    return {
        "id": question.id,
        "question_number": question.question_index + 1,
        "total_questions": room.question_count,
        "question_text": question.question_text,
        "options": parse_json_list(question.options_json),
        "category": question.category,
        "difficulty": question.difficulty,
        "time_limit_seconds": question.time_limit_seconds,
        "started_at": started_at,
        "ends_at": ends_at,
        "remaining_seconds": remaining_seconds,
        "has_answered": viewer_has_answered,
    }


def serialize_last_reveal(room: MultiplayerRoom) -> dict | None:
    question = get_room_current_question(room)
    revealed_at = normalize_datetime(room.question_revealed_at)
    if not question or not revealed_at:
        return None

    player_results = []
    for player in get_active_players(room):
        answer = get_answer_for_player(question, player.id)
        player_results.append(
            {
                "player_id": player.id,
                "user_id": player.user_id,
                "score": player.score,
                "correct_answers": player.correct_answers,
                "answered_questions": player.answered_questions,
                "selected_option_index": answer.selected_option_index if answer else None,
                "is_correct": bool(answer.is_correct) if answer else False,
                "points_awarded": int(answer.points_awarded) if answer else 0,
            }
        )

    options = parse_json_list(question.options_json)
    correct_option = options[question.correct_answer_index] if question.correct_answer_index < len(options) else ""
    return {
        "question_id": question.id,
        "question_number": question.question_index + 1,
        "total_questions": room.question_count,
        "correct_answer_index": question.correct_answer_index,
        "correct_option": correct_option,
        "explanation": question.explanation,
        "revealed_at": revealed_at,
        "next_transition_at": revealed_at + timedelta(seconds=QUESTION_REVEAL_SECONDS),
        "player_results": player_results,
    }


def calculate_lemons(correct_answers: int) -> int:
    return max(0, int(correct_answers) * 5)


def get_or_create_stats_snapshot(db: Session, user_id: int) -> UserStatsSnapshot:
    snapshot = db.scalar(select(UserStatsSnapshot).where(UserStatsSnapshot.user_id == user_id))
    if snapshot:
        return snapshot
    snapshot = UserStatsSnapshot(user_id=user_id)
    db.add(snapshot)
    db.flush()
    return snapshot


def parse_json_object(payload: str | None) -> dict:
    if not payload:
        return {}
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def parse_recent_activity(payload: str | None) -> list[dict]:
    if not payload:
        return []
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def create_notification(
    db: Session,
    *,
    user_id: int,
    notification_type: str,
    title: str,
    message: str,
    related_user_id: int | None = None,
    metadata: dict | None = None,
) -> None:
    db.add(
        Notification(
            user_id=user_id,
            type=notification_type,
            title=title[:140],
            body=message[:320],
            related_user_id=related_user_id,
            metadata_json=serialize_json(metadata) if metadata else None,
        )
    )


def serialize_results(room: MultiplayerRoom) -> dict:
    entries = leaderboard_entries(room)
    winner = room.winner or (
        room.host if room.winner_user_id and room.host and room.host.id == room.winner_user_id else None
    )
    rankings = []
    for entry in entries:
        rankings.append(
            {
                "player_id": entry["player_id"],
                "user_id": entry["user_id"],
                "username": entry["username"],
                "display_name": entry["display_name"],
                "avatar_url": entry["avatar_url"],
                "rank": entry["rank"],
                "score": entry["score"],
                "correct_answers": entry["correct_answers"],
                "answered_questions": entry["answered_questions"],
                "accuracy": entry["accuracy"],
                "lemons_earned": calculate_lemons(entry["correct_answers"]),
                "xp_gained": entry["score"],
                "is_host": entry["is_host"],
                "is_winner": room.winner_user_id == entry["user_id"],
            }
        )
    if room.winner and room.winner.id == room.winner_user_id:
        winner = room.winner
    elif room.winner_user_id:
        for player in room.players:
            if player.user_id == room.winner_user_id:
                winner = player.user
                break

    return {
        "room_id": room.id,
        "winner_user_id": room.winner_user_id,
        "winner": serialize_room_user(winner),
        "rankings": rankings,
        "total_questions": room.question_count,
        "completed_at": room.ended_at,
    }


def serialize_room_detail(room: MultiplayerRoom, viewer_id: int | None = None) -> dict:
    countdown_started_at = normalize_datetime(room.countdown_started_at)
    countdown_ends_at = (
        countdown_started_at + timedelta(seconds=ROOM_COUNTDOWN_SECONDS)
        if countdown_started_at and room.status == "starting"
        else None
    )
    results = serialize_results(room) if room.status in TERMINAL_ROOM_STATUSES else None
    return {
        "room": serialize_room_summary(room),
        "players": [serialize_room_player(player) for player in get_active_players(room)],
        "game": {
            "countdown_started_at": countdown_started_at,
            "countdown_ends_at": countdown_ends_at,
            "current_question": serialize_current_question(room, viewer_id),
            "last_reveal": serialize_last_reveal(room),
            "leaderboard": leaderboard_entries(room),
            "question_duration_seconds": room.question_time_limit_seconds,
            "reveal_duration_seconds": QUESTION_REVEAL_SECONDS,
        },
        "results": results,
    }


def ensure_room_can_join(room: MultiplayerRoom, user_id: int) -> None:
    if room.status in TERMINAL_ROOM_STATUSES:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Room is already closed.")
    existing = get_player_record(room, user_id)
    if existing and existing.left_at is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="You already joined this room.")
    active_players = get_active_players(room)
    if len(active_players) >= room.max_players:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Room is full.")


def assign_new_host_if_needed(room: MultiplayerRoom) -> None:
    active_players = get_active_players(room)
    if not active_players:
        room.host_id = None
        return

    current_host = None
    for player in active_players:
        if player.user_id == room.host_id:
            current_host = player
            break
    if current_host:
        current_host.is_host = True
        return

    next_host = sorted(active_players, key=lambda item: (item.joined_at, item.id))[0]
    room.host_id = next_host.user_id
    for player in active_players:
        player.is_host = player.id == next_host.id


def prepare_room_questions(db: Session, room: MultiplayerRoom) -> None:
    db.query(MultiplayerRoomAnswer).filter(MultiplayerRoomAnswer.room_id == room.id).delete()
    db.query(MultiplayerRoomQuestion).filter(MultiplayerRoomQuestion.room_id == room.id).delete()

    selected_questions = pick_questions(room.category, room.difficulty, room.question_count)
    for index, item in enumerate(selected_questions):
        db.add(
            MultiplayerRoomQuestion(
                room_id=room.id,
                question_index=index,
                question_key=item["id"],
                question_text=item["question"],
                options_json=serialize_json(item["options"]),
                correct_answer_index=item["correct_answer"],
                category=item["category"],
                difficulty=item["difficulty"],
                explanation=item.get("explanation"),
                time_limit_seconds=room.question_time_limit_seconds,
            )
        )

    for player in room.players:
        player.score = 0
        player.correct_answers = 0
        player.answered_questions = 0
        player.current_streak = 0
        player.best_streak = 0


def create_room(db: Session, *, host: User, payload) -> MultiplayerRoom:
    room = MultiplayerRoom(
        room_code=generate_room_code(db),
        host_id=host.id,
        title=payload.title.strip(),
        category=normalize_category(payload.category),
        difficulty=normalize_difficulty(payload.difficulty),
        question_count=payload.question_count,
        max_players=payload.max_players,
        question_time_limit_seconds=QUESTION_DURATION_SECONDS,
        status="waiting",
    )
    db.add(room)
    db.flush()
    db.add(
        MultiplayerRoomPlayer(
            room_id=room.id,
            user_id=host.id,
            is_host=True,
            is_ready=True,
            is_connected=True,
            last_seen_at=now_utc(),
        )
    )
    db.commit()
    return get_room_or_404(db, room.id)


def join_room(db: Session, *, room: MultiplayerRoom, user: User) -> MultiplayerRoom:
    ensure_room_can_join(room, user.id)
    existing = get_player_record(room, user.id)
    if existing:
        existing.left_at = None
        existing.is_connected = True
        existing.last_seen_at = now_utc()
    else:
        db.add(
            MultiplayerRoomPlayer(
                room_id=room.id,
                user_id=user.id,
                is_connected=True,
                last_seen_at=now_utc(),
            )
        )
    db.commit()
    return get_room_or_404(db, room.id)


def leave_room(db: Session, *, room: MultiplayerRoom, user: User) -> MultiplayerRoom:
    player = get_player_record(room, user.id)
    if not player or player.left_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="You are not in this room.")

    left_at = now_utc()
    player.left_at = left_at
    player.is_connected = False
    player.is_ready = False
    player.last_seen_at = left_at
    assign_new_host_if_needed(room)

    active_players = get_active_players(room)
    if not active_players and room.status == "waiting":
        room.status = "cancelled"
        room.ended_at = left_at
    elif room.status in {"starting", "in_progress"} and not active_players:
        room.status = "cancelled"
        room.ended_at = left_at

    db.commit()
    return get_room_or_404(db, room.id)


def invite_friend_to_room(db: Session, *, room: MultiplayerRoom, sender: User, friend_user_id: int) -> None:
    if sender.id == friend_user_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot invite yourself.")

    friend = db.get(User, friend_user_id)
    if not friend:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Friend not found.")

    friendship = db.scalar(
        select(Friendship).where(
            or_(
                and_(Friendship.user_one_id == sender.id, Friendship.user_two_id == friend_user_id),
                and_(Friendship.user_one_id == friend_user_id, Friendship.user_two_id == sender.id),
            )
        )
    )
    if not friendship:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only invite friends.")

    create_notification(
        db,
        user_id=friend_user_id,
        notification_type="multiplayer_room_invite",
        title=f"{safe_display_name(sender)} invited you to a room",
        message=f"Join room {room.room_code} in English Lemon multiplayer.",
        related_user_id=sender.id,
        metadata={"room_id": room.id, "room_code": room.room_code},
    )
    db.commit()


def start_room(db: Session, *, room: MultiplayerRoom, user: User) -> MultiplayerRoom:
    if room.host_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the host can start the room.")
    if room.status != "waiting":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Room cannot be started again.")
    if not get_active_players(room):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Room has no players.")

    room.status = "starting"
    room.countdown_started_at = now_utc()
    room.current_question_index = 0
    room.current_question_started_at = None
    room.question_revealed_at = None
    room.started_at = None
    room.ended_at = None
    room.winner_user_id = None
    prepare_room_questions(db, room)
    db.commit()
    return get_room_or_404(db, room.id)


def all_answered_for_current_question(room: MultiplayerRoom) -> bool:
    question = get_room_current_question(room)
    if not question:
        return False
    active_players = [player for player in get_playing_players(room) if player.left_at is None and player.is_connected]
    if not active_players:
        return False
    answer_player_ids = {answer.player_id for answer in question.answers}
    return all(player.id in answer_player_ids for player in active_players)


def update_player_presence(db: Session, *, room_id: int, user_id: int, is_connected: bool) -> MultiplayerRoom | None:
    room = db.execute(get_room_query().where(MultiplayerRoom.id == room_id)).unique().scalar_one_or_none()
    if not room:
        return None
    player = get_player_record(room, user_id)
    if not player or player.left_at is not None:
        return room
    player.is_connected = is_connected
    player.last_seen_at = now_utc()
    db.commit()
    return get_room_or_404(db, room.id)


def submit_answer(db: Session, *, room: MultiplayerRoom, user: User, question_id: int, selected_option_index: int) -> dict:
    if room.status != "in_progress":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The game is not live yet.")

    player = get_player_record(room, user.id)
    if not player or player.left_at is not None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You are not an active player in this room.")

    question = get_room_current_question(room)
    if not question or question.id != question_id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This question is no longer active.")

    existing_answer = get_answer_for_player(question, player.id)
    if existing_answer:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="You already answered this question.")

    options = parse_json_list(question.options_json)
    if selected_option_index < 0 or selected_option_index >= len(options):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Invalid answer option.")

    started_at = normalize_datetime(room.current_question_started_at) or now_utc()
    response_time_ms = max(0, int((now_utc() - started_at).total_seconds() * 1000))
    is_correct = selected_option_index == question.correct_answer_index
    points_awarded = calculate_answer_points(question, response_time_ms, is_correct)

    db.add(
        MultiplayerRoomAnswer(
            room_id=room.id,
            room_question_id=question.id,
            player_id=player.id,
            selected_option_index=selected_option_index,
            is_correct=is_correct,
            points_awarded=points_awarded,
            response_time_ms=response_time_ms,
        )
    )

    player.score += points_awarded
    player.answered_questions += 1
    if is_correct:
        player.correct_answers += 1
        player.current_streak += 1
        player.best_streak = max(player.best_streak, player.current_streak)
    else:
        player.current_streak = 0

    db.commit()
    updated_room = get_room_or_404(db, room.id)
    active_players = get_playing_players(updated_room)
    current_question = get_room_current_question(updated_room)
    answered_count = len(current_question.answers) if current_question else 0
    return {
        "room": updated_room,
        "event": {
            "type": "answer.submitted",
            "question_id": question.id,
            "player_id": player.id,
            "user_id": user.id,
            "answered_count": answered_count,
            "total_players": len(active_players),
        },
    }


def mark_room_completed(db: Session, room: MultiplayerRoom) -> MultiplayerRoom:
    if room.status in TERMINAL_ROOM_STATUSES:
        return room

    room.status = "completed"
    room.ended_at = now_utc()
    room.question_revealed_at = now_utc()

    rankings = leaderboard_entries(room)
    room.winner_user_id = rankings[0]["user_id"] if rankings else None

    for player in get_active_players(room):
        snapshot = get_or_create_stats_snapshot(db, player.user_id)
        snapshot.quizzes_played += 1
        if room.winner_user_id == player.user_id:
            snapshot.quizzes_won += 1
        snapshot.total_points += player.score
        snapshot.total_lemons += calculate_lemons(player.correct_answers)
        snapshot.total_correct_answers += player.correct_answers
        snapshot.total_questions_answered += room.question_count
        snapshot.current_streak = max(snapshot.current_streak, player.current_streak)
        snapshot.best_streak = max(snapshot.best_streak, player.best_streak)

        category_counts = parse_json_object(snapshot.category_counts_json)
        category_counts[room.category] = int(category_counts.get(room.category, 0)) + 1
        snapshot.category_counts_json = serialize_json(category_counts)

        recent_activity = parse_recent_activity(snapshot.recent_activity_json)
        recent_activity.insert(
            0,
            {
                "type": "multiplayer_quiz",
                "title": f"{room.title} finished with {player.score} XP",
                "subtitle": f"{player.correct_answers}/{room.question_count} correct in room {room.room_code}",
                "created_at": room.ended_at.isoformat() if room.ended_at else now_utc().isoformat(),
                "metadata": {
                    "room_id": room.id,
                    "room_code": room.room_code,
                    "winner_user_id": room.winner_user_id,
                },
            },
        )
        snapshot.recent_activity_json = serialize_json(recent_activity[:12])

        create_notification(
            db,
            user_id=player.user_id,
            notification_type="multiplayer_result",
            title="Multiplayer results are ready",
            message=f"Room {room.room_code} has finished. Open results to see the final leaderboard.",
            metadata={"room_id": room.id, "room_code": room.room_code},
        )

    db.commit()
    return get_room_or_404(db, room.id)


@dataclass
class RoomConnection:
    room_id: int
    user_id: int
    websocket: WebSocket
    connection_id: str


class RoomConnectionManager:
    def __init__(self) -> None:
        self.connections: dict[int, dict[str, RoomConnection]] = {}
        self.room_tasks: dict[int, asyncio.Task] = {}

    async def connect(self, room_id: int, user_id: int, websocket: WebSocket, connection_id: str) -> None:
        room_connections = self.connections.setdefault(room_id, {})
        room_connections[connection_id] = RoomConnection(
            room_id=room_id,
            user_id=user_id,
            websocket=websocket,
            connection_id=connection_id,
        )

    async def disconnect(self, room_id: int, connection_id: str) -> None:
        room_connections = self.connections.get(room_id)
        if not room_connections:
            return
        room_connections.pop(connection_id, None)
        if not room_connections:
            self.connections.pop(room_id, None)

    async def safe_close(self, websocket: WebSocket, code: int = 1000, reason: str = "") -> None:
        try:
            if websocket.application_state != WebSocketState.DISCONNECTED:
                await websocket.close(code=code, reason=reason)
        except Exception:
            pass

    async def send_to_room(self, room_id: int, payload: dict) -> None:
        room_connections = list((self.connections.get(room_id) or {}).values())
        for connection in room_connections:
            try:
                await connection.websocket.send_json(payload)
            except Exception:
                await self.disconnect(room_id, connection.connection_id)

    async def broadcast_snapshot(self, room_id: int) -> None:
        if room_id not in self.connections:
            return
        with SessionLocal() as db:
            room = db.execute(get_room_query().where(MultiplayerRoom.id == room_id)).unique().scalar_one_or_none()
            if not room:
                return
            connections = list((self.connections.get(room_id) or {}).values())
            for connection in connections:
                try:
                    await connection.websocket.send_json(
                        {
                            "type": "room.snapshot",
                            "payload": serialize_room_detail(room, connection.user_id),
                        }
                    )
                except Exception:
                    await self.disconnect(room_id, connection.connection_id)

    def schedule(self, room_id: int, coroutine) -> None:
        previous = self.room_tasks.get(room_id)
        if previous and not previous.done():
            previous.cancel()
        task = asyncio.create_task(coroutine)
        self.room_tasks[room_id] = task

        def _cleanup(done_task: asyncio.Task) -> None:
            current = self.room_tasks.get(room_id)
            if current is done_task:
                self.room_tasks.pop(room_id, None)

        task.add_done_callback(_cleanup)

    def cancel(self, room_id: int) -> None:
        existing = self.room_tasks.get(room_id)
        if existing and not existing.done():
            existing.cancel()
        self.room_tasks.pop(room_id, None)


room_manager = RoomConnectionManager()


async def start_first_question_after_countdown(room_id: int) -> None:
    await room_manager.send_to_room(
        room_id,
        {"type": "countdown.started", "duration": ROOM_COUNTDOWN_SECONDS},
    )
    await room_manager.broadcast_snapshot(room_id)
    await asyncio.sleep(ROOM_COUNTDOWN_SECONDS)
    with SessionLocal() as db:
        room = get_room_or_404(db, room_id)
        if room.status != "starting":
            return
        room.status = "in_progress"
        room.started_at = now_utc()
        room.current_question_index = 0
        room.current_question_started_at = now_utc()
        room.question_revealed_at = None
        db.commit()
    await room_manager.send_to_room(room_id, {"type": "game.started"})
    with SessionLocal() as db:
        live_room = get_room_or_404(db, room_id)
        question_payload = serialize_current_question(live_room)
    await room_manager.send_to_room(room_id, {"type": "question.started", "payload": question_payload})
    await room_manager.broadcast_snapshot(room_id)
    room_manager.schedule(room_id, end_current_question_after_timeout(room_id, 0))


async def end_current_question_after_timeout(room_id: int, question_index: int) -> None:
    await asyncio.sleep(QUESTION_DURATION_SECONDS)
    await reveal_current_question(room_id, question_index)


async def reveal_current_question(room_id: int, question_index: int) -> None:
    with SessionLocal() as db:
        room = get_room_or_404(db, room_id)
        if room.status != "in_progress":
            return
        if room.current_question_index != question_index:
            return
        room.question_revealed_at = now_utc()
        db.commit()
        room = get_room_or_404(db, room_id)
        reveal_payload = serialize_last_reveal(room)

    await room_manager.send_to_room(room_id, {"type": "question.revealed", "payload": reveal_payload})
    await room_manager.send_to_room(
        room_id,
        {"type": "score.updated", "leaderboard": serialize_room_detail(room, None)["game"]["leaderboard"]},
    )
    await room_manager.broadcast_snapshot(room_id)
    room_manager.schedule(room_id, advance_after_reveal(room_id, question_index))


async def advance_after_reveal(room_id: int, question_index: int) -> None:
    await asyncio.sleep(QUESTION_REVEAL_SECONDS)
    with SessionLocal() as db:
        room = get_room_or_404(db, room_id)
        if room.status != "in_progress":
            return
        if room.current_question_index != question_index:
            return

        if question_index + 1 >= room.question_count:
            room = mark_room_completed(db, room)
            room_manager.cancel(room_id)
            results = serialize_results(room)
            await room_manager.send_to_room(room_id, {"type": "game.ended", "payload": results})
            await room_manager.broadcast_snapshot(room_id)
            return

        room.current_question_index = question_index + 1
        room.current_question_started_at = now_utc()
        room.question_revealed_at = None
        db.commit()
        room = get_room_or_404(db, room_id)
        question_payload = serialize_current_question(room)

    await room_manager.send_to_room(room_id, {"type": "question.started", "payload": question_payload})
    await room_manager.broadcast_snapshot(room_id)
    room_manager.schedule(room_id, end_current_question_after_timeout(room_id, question_index + 1))


def build_room_detail_response(room: MultiplayerRoom, viewer_id: int | None = None) -> RoomDetailResponse:
    return RoomDetailResponse.model_validate(serialize_room_detail(room, viewer_id))
