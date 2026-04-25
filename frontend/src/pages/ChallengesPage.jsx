import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import NotificationBell from "../components/notifications/NotificationBell";
import {
  acceptChallengeInvite,
  createChallenge,
  declineChallengeInvite,
  getChallenge,
  listChallenges,
  listIncomingChallenges,
  listOutgoingChallenges,
  rematchChallenge,
  startChallenge,
  submitChallenge
} from "../api/challenges";
import { listFriends } from "../api/social";
import { useAuth } from "../context/AuthContext";
import { QUIZ_CATEGORY_OPTIONS } from "../features/quiz/constants";
import { quizQuestions } from "../features/quiz/data/quizQuestions";
import {
  calculateLemons,
  calculateQuizResults
} from "../features/quiz/utils/quizScoring";
import "../features/challenges/challenges.css";

const CHALLENGE_TABS = [
  { id: "incoming", label: "Incoming" },
  { id: "outgoing", label: "Outgoing" },
  { id: "completed", label: "Completed" }
];

const CHALLENGE_TYPE_OPTIONS = [
  { value: "quick_quiz", label: "Quick Quiz Challenge" },
  { value: "vocabulary", label: "Vocabulary Challenge" },
  { value: "grammar", label: "Grammar Challenge" },
  { value: "mixed", label: "Mixed Challenge" }
];

const DIFFICULTY_OPTIONS = ["Mixed", "Easy", "Medium", "Advanced"];
const EXPIRY_OPTIONS = [
  { label: "30 minutes", value: 30 },
  { label: "2 hours", value: 120 },
  { label: "24 hours", value: 1440 },
  { label: "3 days", value: 4320 }
];

const STATUS_META = {
  pending: { label: "Pending", tone: "is-pending" },
  accepted: { label: "Accepted", tone: "is-accepted" },
  declined: { label: "Declined", tone: "is-declined" },
  expired: { label: "Expired", tone: "is-expired" },
  canceled: { label: "Canceled", tone: "is-canceled" },
  completed: { label: "Completed", tone: "is-completed" }
};

const EMPTY_BY_TAB = {
  incoming: {
    title: "No incoming challenges",
    description: "Friend invites and competitive requests will land here."
  },
  outgoing: {
    title: "No outgoing challenges",
    description: "Send a fresh challenge to get a head-to-head session started."
  },
  completed: {
    title: "No completed challenges",
    description: "Once both players finish, the final result cards will show up here."
  }
};

function toSafeArray(value) {
  return Array.isArray(value) ? value : [];
}

function toSafeNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function formatDateLabel(value, { withTime = true } = {}) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "Recently";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {})
  }).format(parsed);
}

function formatRelativeTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "just now";
  }
  const diffMs = Date.now() - parsed.getTime();
  if (diffMs < 60_000) {
    return "just now";
  }
  if (diffMs < 60 * 60_000) {
    return `${Math.max(1, Math.round(diffMs / 60_000))}m ago`;
  }
  if (diffMs < 24 * 60 * 60_000) {
    return `${Math.max(1, Math.round(diffMs / (60 * 60_000)))}h ago`;
  }
  return formatDateLabel(value, { withTime: false });
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.floor(toSafeNumber(seconds)));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function getInitials(user) {
  const source =
    user?.display_name?.trim() ||
    user?.username?.trim() ||
    user?.email?.split("@")?.[0] ||
    "EL";
  return (
    source
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((chunk) => chunk[0]?.toUpperCase() ?? "")
      .join("") || "EL"
  );
}

function displayNameForUser(user) {
  return user?.display_name || user?.username || user?.email || "Player";
}

function getStatusMeta(challenge) {
  const statusKey =
    challenge?.is_expired && challenge?.status === "pending"
      ? "expired"
      : challenge?.status || "pending";
  return STATUS_META[statusKey] || STATUS_META.pending;
}

function normalizeQuestionBank(source) {
  if (!Array.isArray(source)) {
    return [];
  }
  return source.filter(
    (question) =>
      question &&
      typeof question.question === "string" &&
      Array.isArray(question.options) &&
      question.options.length === 4 &&
      Number.isInteger(question.correctAnswer)
  );
}

function shuffle(items) {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
  }
  return next;
}

function getChallengeCategory(challenge) {
  if (challenge?.category && challenge.category !== "Mixed") {
    return challenge.category;
  }
  if (challenge?.challenge_type === "vocabulary") {
    return "Vocabulary";
  }
  if (challenge?.challenge_type === "grammar") {
    return "Grammar";
  }
  return "Mixed";
}

function buildChallengeQuestionSet(challenge, questionCount) {
  const normalizedBank = normalizeQuestionBank(quizQuestions);
  const category = getChallengeCategory(challenge);
  const difficulty = challenge?.difficulty || "Mixed";

  let filtered = normalizedBank;
  if (category !== "Mixed") {
    const categoryMatches = normalizedBank.filter((question) => question.category === category);
    if (categoryMatches.length >= 4) {
      filtered = categoryMatches;
    }
  }

  if (difficulty !== "Mixed") {
    const difficultyMatches = filtered.filter((question) => question.difficulty === difficulty);
    if (difficultyMatches.length >= 4) {
      filtered = difficultyMatches;
    }
  }

  const safeCount = Math.max(4, Math.min(questionCount || 10, filtered.length || normalizedBank.length));
  const source = filtered.length ? filtered : normalizedBank;
  return shuffle(source).slice(0, safeCount);
}

function getOwnResult(challenge, userId) {
  const metadata = challenge?.metadata || {};
  if (challenge?.challenger?.id === userId) {
    return metadata.challenger_result || null;
  }
  if (challenge?.challenged?.id === userId) {
    return metadata.challenged_result || null;
  }
  return null;
}

function getOpponentResult(challenge, userId) {
  const metadata = challenge?.metadata || {};
  if (challenge?.challenger?.id === userId) {
    return metadata.challenged_result || null;
  }
  if (challenge?.challenged?.id === userId) {
    return metadata.challenger_result || null;
  }
  return null;
}

function getChallengeTypeLabel(value) {
  return (
    CHALLENGE_TYPE_OPTIONS.find((option) => option.value === value)?.label ||
    "Quick Quiz Challenge"
  );
}

function ChallengeEmptyState({ title, description, action, actionLabel }) {
  return (
    <article className="challenge-empty-card">
      <span className="brand-mark">English Lemon</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action && actionLabel ? (
        <button type="button" className="secondary-btn" onClick={action}>
          {actionLabel}
        </button>
      ) : null}
    </article>
  );
}

function ChallengeSkeletonList() {
  return (
    <div className="challenge-card-list">
      {[0, 1, 2].map((value) => (
        <article key={value} className="challenge-card challenge-skeleton-card" aria-hidden="true">
          <div className="challenge-skeleton-line is-wide" />
          <div className="challenge-skeleton-line" />
          <div className="challenge-skeleton-row">
            <div className="challenge-skeleton-pill" />
            <div className="challenge-skeleton-pill" />
          </div>
        </article>
      ))}
    </div>
  );
}

function ChallengeCard({
  challenge,
  currentUserId,
  isActive,
  actionKey,
  onOpen,
  onAccept,
  onDecline,
  onStart,
  onViewResult,
  onRematch
}) {
  const statusMeta = getStatusMeta(challenge);
  const actionBusy = (action) => actionKey === `${action}-${challenge.id}`;
  const challengerName = displayNameForUser(challenge.challenger);
  const opponentName = displayNameForUser(challenge.challenged);

  return (
    <article className={`challenge-card ${statusMeta.tone} ${isActive ? "is-active" : ""}`}>
      <button type="button" className="challenge-card-open" onClick={() => onOpen(challenge.id)}>
        <div className="challenge-card-head">
          <div>
            <h3>{challenge.title}</h3>
            <p>
              {challengerName} vs {opponentName}
            </p>
          </div>
          <span className={`challenge-status-chip ${statusMeta.tone}`}>{statusMeta.label}</span>
        </div>

        <div className="challenge-player-row">
          {[challenge.challenger, challenge.challenged].map((player) => (
            <div key={player.id} className="challenge-player-mini">
              <span className="challenge-avatar">{getInitials(player)}</span>
              <div>
                <strong>{displayNameForUser(player)}</strong>
                <span>{player.email || `@${player.username}`}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="challenge-meta-row">
          <span>{getChallengeTypeLabel(challenge.challenge_type)}</span>
          {challenge.category ? <span>{challenge.category}</span> : null}
          {challenge.difficulty ? <span>{challenge.difficulty}</span> : null}
          <span>{formatRelativeTime(challenge.created_at)}</span>
        </div>
      </button>

      <div className="challenge-card-actions">
        {challenge.can_accept ? (
          <button
            type="button"
            className="primary-btn challenge-mini-btn"
            onClick={() => onAccept(challenge.id)}
            disabled={actionBusy("accept")}
          >
            {actionBusy("accept") ? "Accepting..." : "Accept"}
          </button>
        ) : null}
        {challenge.can_decline ? (
          <button
            type="button"
            className="secondary-btn challenge-mini-btn"
            onClick={() => onDecline(challenge.id)}
            disabled={actionBusy("decline")}
          >
            {actionBusy("decline") ? "Declining..." : "Decline"}
          </button>
        ) : null}
        {challenge.can_start ? (
          <button
            type="button"
            className="primary-btn challenge-mini-btn"
            onClick={() => onStart(challenge.id)}
          >
            Start Challenge
          </button>
        ) : null}
        {challenge.can_view_result ? (
          <button
            type="button"
            className="secondary-btn challenge-mini-btn"
            onClick={() => onViewResult(challenge.id)}
          >
            View Result
          </button>
        ) : null}
        {challenge.can_rematch ? (
          <button
            type="button"
            className="secondary-btn challenge-mini-btn"
            onClick={() => onRematch(challenge.id)}
            disabled={actionBusy("rematch")}
          >
            {actionBusy("rematch") ? "Sending..." : "Rematch"}
          </button>
        ) : null}
        {!challenge.can_accept &&
        !challenge.can_decline &&
        !challenge.can_start &&
        !challenge.can_view_result &&
        !challenge.can_rematch ? (
          <button type="button" className="secondary-btn challenge-mini-btn" onClick={() => onOpen(challenge.id)}>
            Open
          </button>
        ) : null}
      </div>

      {currentUserId && challenge.winner_id ? (
        <p className="challenge-outcome-note">
          {challenge.winner_id === currentUserId ? "You won this challenge." : "You’re chasing the rematch."}
        </p>
      ) : null}
    </article>
  );
}

function ChallengesPage() {
  const navigate = useNavigate();
  const { challengeId } = useParams();
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState("incoming");
  const [friends, setFriends] = useState([]);
  const [incomingChallenges, setIncomingChallenges] = useState([]);
  const [outgoingChallenges, setOutgoingChallenges] = useState([]);
  const [completedChallenges, setCompletedChallenges] = useState([]);
  const [loadingHub, setLoadingHub] = useState(true);
  const [hubError, setHubError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [selectedChallenge, setSelectedChallenge] = useState(null);
  const [actionKey, setActionKey] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createForm, setCreateForm] = useState({
    opponentId: "",
    challengeType: "quick_quiz",
    category: QUIZ_CATEGORY_OPTIONS[0],
    difficulty: DIFFICULTY_OPTIONS[0],
    expiresInMinutes: EXPIRY_OPTIONS[2].value
  });
  const [playState, setPlayState] = useState({
    phase: "idle",
    challengeId: null,
    questions: [],
    currentIndex: 0,
    answers: [],
    timerSeconds: 0,
    totalTimeSeconds: 0,
    submitting: false
  });
  const timerRef = useRef(0);

  const selectedChallengeId = challengeId ? Number(challengeId) : null;

  const visibleChallenges = useMemo(() => {
    if (activeTab === "incoming") {
      return toSafeArray(incomingChallenges);
    }
    if (activeTab === "outgoing") {
      return toSafeArray(outgoingChallenges);
    }
    return toSafeArray(completedChallenges);
  }, [activeTab, completedChallenges, incomingChallenges, outgoingChallenges]);

  useEffect(
    () => () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
      }
    },
    []
  );

  const loadHub = async ({ silent = false } = {}) => {
    if (!silent) {
      setLoadingHub(true);
    }
    try {
      const [friendsResponse, incomingResponse, outgoingResponse, completedResponse] = await Promise.all([
        listFriends(),
        listIncomingChallenges(),
        listOutgoingChallenges(),
        listChallenges({ status: "completed" })
      ]);

      setFriends(toSafeArray(friendsResponse));
      setIncomingChallenges(toSafeArray(incomingResponse));
      setOutgoingChallenges(toSafeArray(outgoingResponse));
      setCompletedChallenges(toSafeArray(completedResponse));
      setHubError("");
    } catch (error) {
      setHubError(error?.detail || error?.message || "Unable to load challenges.");
    } finally {
      if (!silent) {
        setLoadingHub(false);
      }
    }
  };

  const loadChallengeDetail = async (id, { silent = false } = {}) => {
    if (!Number.isFinite(id)) {
      setSelectedChallenge(null);
      return;
    }
    if (!silent) {
      setDetailLoading(true);
    }
    try {
      const response = await getChallenge(id);
      setSelectedChallenge(response);
      setDetailError("");
    } catch (error) {
      setDetailError(error?.detail || error?.message || "Unable to load challenge.");
    } finally {
      if (!silent) {
        setDetailLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadHub();
  }, []);

  useEffect(() => {
    if (selectedChallengeId) {
      void loadChallengeDetail(selectedChallengeId);
    } else {
      setSelectedChallenge(null);
      setDetailError("");
    }
  }, [selectedChallengeId]);

  useEffect(() => {
    if (playState.phase !== "playing" || playState.timerSeconds <= 0) {
      return undefined;
    }
    timerRef.current = window.setInterval(() => {
      setPlayState((current) => {
        if (current.phase !== "playing") {
          return current;
        }
        const nextSeconds = current.timerSeconds - 1;
        if (nextSeconds <= 0) {
          window.clearInterval(timerRef.current);
          return { ...current, timerSeconds: 0 };
        }
        return { ...current, timerSeconds: nextSeconds };
      });
    }, 1000);
    return () => {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
      }
    };
  }, [playState.phase, playState.timerSeconds]);

  const currentQuestion = playState.questions[playState.currentIndex] || null;
  const progressPercent = playState.questions.length
    ? Math.round(((playState.currentIndex + 1) / playState.questions.length) * 100)
    : 0;
  const ownResult = getOwnResult(selectedChallenge, user?.id);
  const opponentResult = getOpponentResult(selectedChallenge, user?.id);
  const challengeStatusMeta = getStatusMeta(selectedChallenge);

  const openChallenge = (id) => {
    navigate(id ? `/challenges/${id}` : "/challenges");
  };

  const resetPlayState = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
    }
    setPlayState({
      phase: "idle",
      challengeId: null,
      questions: [],
      currentIndex: 0,
      answers: [],
      timerSeconds: 0,
      totalTimeSeconds: 0,
      submitting: false
    });
  };

  const handleCreateChallenge = async (event) => {
    event.preventDefault();
    if (!createForm.opponentId) {
      setCreateError("Choose a friend first.");
      return;
    }
    setCreateLoading(true);
    setCreateError("");
    try {
      const created = await createChallenge({
        opponent_id: Number(createForm.opponentId),
        challenge_type: createForm.challengeType,
        category: createForm.category === "Mixed" ? null : createForm.category,
        difficulty: createForm.difficulty === "Mixed" ? null : createForm.difficulty,
        expires_in_minutes: Number(createForm.expiresInMinutes)
      });
      setIsCreateOpen(false);
      setStatusNote("Challenge sent.");
      await loadHub({ silent: true });
      openChallenge(created.id);
    } catch (error) {
      setCreateError(error?.detail || error?.message || "Unable to create challenge.");
    } finally {
      setCreateLoading(false);
    }
  };

  const handleAction = async (challenge, action) => {
    setActionKey(`${action}-${challenge.id}`);
    try {
      if (action === "accept") {
        await acceptChallengeInvite(challenge.id);
        setStatusNote("Challenge accepted.");
      } else if (action === "decline") {
        await declineChallengeInvite(challenge.id);
        setStatusNote("Challenge declined.");
      } else if (action === "rematch") {
        const rematch = await rematchChallenge(challenge.id);
        setStatusNote("Rematch sent.");
        await loadHub({ silent: true });
        openChallenge(rematch.id);
        return;
      }
      await Promise.all([loadHub({ silent: true }), loadChallengeDetail(challenge.id, { silent: true })]);
    } catch (error) {
      setStatusNote(error?.detail || error?.message || "Unable to update challenge.");
    } finally {
      setActionKey("");
    }
  };

  const handleStart = async () => {
    if (!selectedChallenge?.id) {
      return;
    }
    setActionKey(`start-${selectedChallenge.id}`);
    try {
      const payload = await startChallenge(selectedChallenge.id);
      const questions = buildChallengeQuestionSet(payload?.challenge || selectedChallenge, payload?.question_count || 10);
      setSelectedChallenge(payload?.challenge || selectedChallenge);
      setPlayState({
        phase: "playing",
        challengeId: selectedChallenge.id,
        questions,
        currentIndex: 0,
        answers: [],
        timerSeconds: toSafeNumber(payload?.total_time_seconds, 180),
        totalTimeSeconds: toSafeNumber(payload?.total_time_seconds, 180),
        submitting: false
      });
      setStatusNote("Challenge started.");
    } catch (error) {
      setStatusNote(error?.detail || error?.message || "Unable to start challenge.");
    } finally {
      setActionKey("");
    }
  };

  const finalizeChallenge = async (answerHistory) => {
    if (!selectedChallenge?.id) {
      return;
    }
    const results = calculateQuizResults(answerHistory, playState.questions.length, 0);
    setPlayState((current) => ({ ...current, phase: "submitting", submitting: true }));
    try {
      const response = await submitChallenge(selectedChallenge.id, {
        score: results.totalCorrect,
        correct_answers: results.totalCorrect,
        total_questions: playState.questions.length,
        accuracy: results.accuracy,
        lemons_earned: calculateLemons(results.totalCorrect),
        xp_gained: Math.max(40, results.totalCorrect * 12)
      });
      setSelectedChallenge(response.challenge);
      setStatusNote(response.waiting_for_opponent ? "Result submitted. Waiting for your opponent." : "Challenge complete.");
      await loadHub({ silent: true });
      resetPlayState();
    } catch (error) {
      setStatusNote(error?.detail || error?.message || "Unable to submit challenge.");
      setPlayState((current) => ({ ...current, phase: "playing", submitting: false }));
    }
  };

  const handleSelectAnswer = (optionIndex) => {
    if (playState.phase !== "playing" || !currentQuestion) {
      return;
    }
    const nextAnswers = [
      ...playState.answers,
      {
        questionId: currentQuestion.id,
        selectedIndex: optionIndex,
        isCorrect: optionIndex === currentQuestion.correctAnswer
      }
    ];
    const isLast = playState.currentIndex >= playState.questions.length - 1;
    if (isLast) {
      void finalizeChallenge(nextAnswers);
      return;
    }
    setPlayState((current) => ({
      ...current,
      answers: nextAnswers,
      currentIndex: current.currentIndex + 1
    }));
  };

  useEffect(() => {
    if (playState.phase === "playing" && playState.timerSeconds === 0 && playState.questions.length) {
      void finalizeChallenge(playState.answers);
    }
  }, [playState.answers, playState.phase, playState.questions.length, playState.timerSeconds]);

  const detailPanel = (() => {
    if (detailLoading) {
      return (
        <section className="feature-card challenge-detail-card">
          <ChallengeSkeletonList />
        </section>
      );
    }

    if (detailError) {
      return (
        <section className="feature-card challenge-detail-card">
          <ChallengeEmptyState
            title="Challenge detail unavailable"
            description={detailError}
          />
        </section>
      );
    }

    if (!selectedChallenge) {
      return (
        <section className="feature-card challenge-detail-card">
          <ChallengeEmptyState
            title="Select a challenge"
            description="Choose a card from the left to review the invite, play the round, or inspect the result."
          />
        </section>
      );
    }

    if (playState.phase === "playing" || playState.phase === "submitting") {
      return (
        <section className="feature-card challenge-detail-card">
          <div className="challenge-play-header">
            <div>
              <span className="brand-mark">{getChallengeTypeLabel(selectedChallenge.challenge_type)}</span>
              <h2>{selectedChallenge.title}</h2>
              <p className="subtle-text">
                {displayNameForUser(selectedChallenge.challenger)} vs{" "}
                {displayNameForUser(selectedChallenge.challenged)}
              </p>
            </div>
            <div className="challenge-play-timer">
              <span>Time Left</span>
              <strong>{formatDuration(playState.timerSeconds)}</strong>
            </div>
          </div>

          <div className="challenge-progress-track" aria-hidden="true">
            <div style={{ width: `${progressPercent}%` }} />
          </div>

          {currentQuestion ? (
            <div className="challenge-question-card">
              <p className="challenge-question-count">
                Question {playState.currentIndex + 1} / {playState.questions.length}
              </p>
              <h3>{currentQuestion.question}</h3>
              <div className="challenge-option-grid">
                {currentQuestion.options.map((option, index) => (
                  <button
                    key={`${currentQuestion.id}-${option}`}
                    type="button"
                    className="challenge-option-btn"
                    onClick={() => handleSelectAnswer(index)}
                    disabled={playState.phase === "submitting"}
                  >
                    <span>{["A", "B", "C", "D"][index]}</span>
                    <strong>{option}</strong>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {playState.phase === "submitting" ? <p className="subtle-text">Submitting your result...</p> : null}
        </section>
      );
    }

    return (
      <section className="feature-card challenge-detail-card">
        <div className="challenge-detail-head">
          <div>
            <span className="brand-mark">{getChallengeTypeLabel(selectedChallenge.challenge_type)}</span>
            <h2>{selectedChallenge.title}</h2>
            <p className="subtle-text">
              Created {formatDateLabel(selectedChallenge.created_at)} · {selectedChallenge.category || "Mixed"} ·{" "}
              {selectedChallenge.difficulty || "Mixed"}
            </p>
          </div>
          <span className={`challenge-status-chip ${challengeStatusMeta.tone}`}>{challengeStatusMeta.label}</span>
        </div>

        <div className="challenge-detail-players">
          {[selectedChallenge.challenger, selectedChallenge.challenged].map((player) => {
            const isWinner = selectedChallenge.winner_id === player.id;
            return (
              <article key={player.id} className={`challenge-player-card ${isWinner ? "is-winner" : ""}`}>
                <span className="challenge-avatar is-large">{getInitials(player)}</span>
                <strong>{displayNameForUser(player)}</strong>
                <span>{player.email || `@${player.username}`}</span>
                <small>{isWinner ? "Winner" : "Competitor"}</small>
              </article>
            );
          })}
        </div>

        {selectedChallenge.status === "pending" ? (
          <div className="challenge-state-block">
            <h3>Invite Pending</h3>
            <p>
              {selectedChallenge.can_accept
                ? "You have a live challenge invite waiting. Accept to unlock the round."
                : "Waiting for your friend to respond to the invite."}
            </p>
          </div>
        ) : null}

        {selectedChallenge.status === "accepted" && !ownResult ? (
          <div className="challenge-state-block">
            <h3>Ready to play</h3>
            <p>
              Clean round, fixed question count, and a direct score race. Start when you’re ready.
            </p>
          </div>
        ) : null}

        {ownResult && !opponentResult && selectedChallenge.status !== "completed" ? (
          <div className="challenge-state-block">
            <h3>Result locked in</h3>
            <p>
              You submitted {ownResult.correct_answers}/{ownResult.total_questions} correct. Waiting for your
              opponent to finish.
            </p>
          </div>
        ) : null}

        {selectedChallenge.status === "completed" ? (
          <div className="challenge-result-grid">
            <article>
              <span>Your Correct</span>
              <strong>
                {toSafeNumber(ownResult?.correct_answers)} / {toSafeNumber(ownResult?.total_questions)}
              </strong>
            </article>
            <article>
              <span>Your Accuracy</span>
              <strong>{toSafeNumber(ownResult?.accuracy)}%</strong>
            </article>
            <article>
              <span>Opponent Accuracy</span>
              <strong>{toSafeNumber(opponentResult?.accuracy)}%</strong>
            </article>
            <article>
              <span>Lemons Earned</span>
              <strong>{toSafeNumber(ownResult?.lemons_earned)}</strong>
            </article>
          </div>
        ) : null}

        {selectedChallenge.result_summary ? (
          <p className="challenge-result-summary">{selectedChallenge.result_summary}</p>
        ) : null}

        <div className="challenge-detail-actions">
          {selectedChallenge.can_accept ? (
            <button
              type="button"
              className="primary-btn"
              onClick={() => handleAction(selectedChallenge, "accept")}
              disabled={actionKey === `accept-${selectedChallenge.id}`}
            >
              {actionKey === `accept-${selectedChallenge.id}` ? "Accepting..." : "Accept"}
            </button>
          ) : null}
          {selectedChallenge.can_decline ? (
            <button
              type="button"
              className="secondary-btn"
              onClick={() => handleAction(selectedChallenge, "decline")}
              disabled={actionKey === `decline-${selectedChallenge.id}`}
            >
              {actionKey === `decline-${selectedChallenge.id}` ? "Declining..." : "Decline"}
            </button>
          ) : null}
          {selectedChallenge.can_start ? (
            <button
              type="button"
              className="primary-btn"
              onClick={handleStart}
              disabled={Boolean(getOwnResult(selectedChallenge, user?.id)) || actionKey === `start-${selectedChallenge.id}`}
            >
              {actionKey === `start-${selectedChallenge.id}` ? "Preparing..." : "Start Challenge"}
            </button>
          ) : null}
          {selectedChallenge.can_rematch ? (
            <button
              type="button"
              className="secondary-btn"
              onClick={() => handleAction(selectedChallenge, "rematch")}
              disabled={actionKey === `rematch-${selectedChallenge.id}`}
            >
              {actionKey === `rematch-${selectedChallenge.id}` ? "Sending..." : "Rematch"}
            </button>
          ) : null}
          <button
            type="button"
            className="secondary-btn"
            onClick={() => navigate("/social", { state: { conversationId: selectedChallenge.conversation_id } })}
          >
            Open Chat
          </button>
        </div>
      </section>
    );
  })();

  const currentEmpty = EMPTY_BY_TAB[activeTab];

  return (
    <main className="page-shell challenges-page">
      <section className="challenge-shell">
        <header className="feature-card challenge-hero">
          <div className="challenge-hero-copy">
            <span className="brand-mark">English Lemon</span>
            <h1>Challenges</h1>
            <p className="challenge-hero-subtitle">
              Send friends into focused English head-to-head rounds, track clean results, and fire back rematches.
            </p>
            <div className="challenge-hero-metrics">
              <article>
                <strong>{incomingChallenges.length}</strong>
                <span>Incoming</span>
              </article>
              <article>
                <strong>{outgoingChallenges.length}</strong>
                <span>Outgoing</span>
              </article>
              <article>
                <strong>{completedChallenges.length}</strong>
                <span>Completed</span>
              </article>
            </div>
          </div>
          <div className="challenge-hero-actions">
            <NotificationBell compact />
            <button type="button" className="primary-btn" onClick={() => setIsCreateOpen(true)}>
              New Challenge
            </button>
            <button type="button" className="secondary-btn" onClick={() => navigate("/dashboard")}>
              Back to Dashboard
            </button>
          </div>
        </header>

        {statusNote ? <p className="challenge-status-note">{statusNote}</p> : null}
        {hubError ? <p className="error-text">{hubError}</p> : null}

        <section className="challenge-layout">
          <aside className="feature-card challenge-sidebar">
            <div className="challenge-tab-row" role="tablist" aria-label="Challenge tabs">
              {CHALLENGE_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`challenge-tab-btn ${activeTab === tab.id ? "is-active" : ""}`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {loadingHub ? <ChallengeSkeletonList /> : null}

            {!loadingHub && !visibleChallenges.length ? (
              <ChallengeEmptyState
                title={currentEmpty.title}
                description={currentEmpty.description}
                action={friends.length ? () => setIsCreateOpen(true) : undefined}
                actionLabel={friends.length ? "Challenge a Friend" : undefined}
              />
            ) : null}

            {!loadingHub ? (
              <div className="challenge-card-list">
                {visibleChallenges.map((challenge) => (
                  <ChallengeCard
                    key={challenge.id}
                    challenge={challenge}
                    currentUserId={user?.id}
                    isActive={selectedChallengeId === challenge.id}
                    actionKey={actionKey}
                    onOpen={openChallenge}
                    onAccept={(id) => handleAction({ ...challenge, id }, "accept")}
                    onDecline={(id) => handleAction({ ...challenge, id }, "decline")}
                    onStart={openChallenge}
                    onViewResult={openChallenge}
                    onRematch={(id) => handleAction({ ...challenge, id }, "rematch")}
                  />
                ))}
              </div>
            ) : null}
          </aside>

          <div className="challenge-detail-column">{detailPanel}</div>
        </section>

        {isCreateOpen ? (
          <div className="challenge-modal-overlay" role="presentation">
            <section className="challenge-modal-card" role="dialog" aria-modal="true">
              <header className="challenge-modal-head">
                <div>
                  <span className="brand-mark">English Lemon</span>
                  <h2>Create Challenge</h2>
                </div>
                <button type="button" className="secondary-btn" onClick={() => setIsCreateOpen(false)} disabled={createLoading}>
                  Close
                </button>
              </header>

              {!friends.length ? (
                <ChallengeEmptyState
                  title="No friends available"
                  description="Add a friend in Social Arena before you launch your first challenge."
                />
              ) : (
                <form className="challenge-modal-form" onSubmit={handleCreateChallenge}>
                  <label>
                    Friend
                    <select
                      value={createForm.opponentId}
                      onChange={(event) => setCreateForm((current) => ({ ...current, opponentId: event.target.value }))}
                      disabled={createLoading}
                    >
                      <option value="">Select a friend</option>
                      {friends.map((entry) => (
                        <option key={entry.friend?.id} value={entry.friend?.id}>
                          {displayNameForUser(entry.friend)}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    Challenge Type
                    <select
                      value={createForm.challengeType}
                      onChange={(event) => {
                        const nextType = event.target.value;
                        setCreateForm((current) => ({
                          ...current,
                          challengeType: nextType,
                          category:
                            nextType === "vocabulary"
                              ? "Vocabulary"
                              : nextType === "grammar"
                                ? "Grammar"
                                : current.category
                        }));
                      }}
                      disabled={createLoading}
                    >
                      {CHALLENGE_TYPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    Category
                    <select
                      value={createForm.category}
                      onChange={(event) => setCreateForm((current) => ({ ...current, category: event.target.value }))}
                      disabled={createLoading}
                    >
                      {QUIZ_CATEGORY_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    Difficulty
                    <select
                      value={createForm.difficulty}
                      onChange={(event) => setCreateForm((current) => ({ ...current, difficulty: event.target.value }))}
                      disabled={createLoading}
                    >
                      {DIFFICULTY_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    Expiration
                    <select
                      value={createForm.expiresInMinutes}
                      onChange={(event) =>
                        setCreateForm((current) => ({
                          ...current,
                          expiresInMinutes: Number(event.target.value)
                        }))
                      }
                      disabled={createLoading}
                    >
                      {EXPIRY_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {createError ? <p className="error-text">{createError}</p> : null}

                  <div className="challenge-modal-actions">
                    <button type="button" className="secondary-btn" onClick={() => setIsCreateOpen(false)} disabled={createLoading}>
                      Cancel
                    </button>
                    <button type="submit" className="primary-btn" disabled={createLoading}>
                      {createLoading ? "Sending..." : "Send Challenge"}
                    </button>
                  </div>
                </form>
              )}
            </section>
          </div>
        ) : null}
      </section>
    </main>
  );
}

export default ChallengesPage;
