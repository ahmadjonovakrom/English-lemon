const QUIZ_PROFILE_STATS_STORAGE_KEY = "english_lemon_quiz_profile_stats";

const DEFAULT_QUIZ_PROFILE_STATS = {
  quizzesPlayed: 0,
  quizzesWon: 0,
  totalPoints: 0,
  totalLemons: 0,
  totalCorrectAnswers: 0,
  totalQuestionsAnswered: 0,
  currentStreak: 0,
  bestStreak: 0,
  categoryCounts: {},
  recentRounds: [],
  lastUpdatedAt: null
};

function toSafeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function toSafeCategoryCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce((accumulator, [category, count]) => {
    const safeCount = Math.max(0, Math.floor(toSafeNumber(count)));
    if (safeCount > 0 && typeof category === "string" && category.trim()) {
      accumulator[category] = safeCount;
    }
    return accumulator;
  }, {});
}

function toSafeRecentRounds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      playedAt:
        typeof entry.playedAt === "string" && entry.playedAt.trim()
          ? entry.playedAt
          : new Date().toISOString(),
      category:
        typeof entry.category === "string" && entry.category.trim()
          ? entry.category.trim()
          : "Mixed",
      lemonsEarned: Math.max(0, Math.floor(toSafeNumber(entry.lemonsEarned))),
      accuracy: Math.max(0, Math.min(100, Math.floor(toSafeNumber(entry.accuracy)))),
      totalCorrect: Math.max(0, Math.floor(toSafeNumber(entry.totalCorrect))),
      totalQuestions: Math.max(0, Math.floor(toSafeNumber(entry.totalQuestions)))
    }))
    .slice(0, 8);
}

export function getDefaultQuizProfileStats() {
  return {
    ...DEFAULT_QUIZ_PROFILE_STATS,
    categoryCounts: {},
    recentRounds: []
  };
}

export function readQuizProfileStats() {
  if (typeof window === "undefined") {
    return getDefaultQuizProfileStats();
  }

  try {
    const raw = window.localStorage.getItem(QUIZ_PROFILE_STATS_STORAGE_KEY);
    if (!raw) {
      return getDefaultQuizProfileStats();
    }

    const parsed = JSON.parse(raw);

    return {
      quizzesPlayed: Math.max(0, Math.floor(toSafeNumber(parsed?.quizzesPlayed))),
      quizzesWon: Math.max(0, Math.floor(toSafeNumber(parsed?.quizzesWon))),
      totalPoints: Math.max(0, Math.floor(toSafeNumber(parsed?.totalPoints))),
      totalLemons: Math.max(0, Math.floor(toSafeNumber(parsed?.totalLemons))),
      totalCorrectAnswers: Math.max(0, Math.floor(toSafeNumber(parsed?.totalCorrectAnswers))),
      totalQuestionsAnswered: Math.max(0, Math.floor(toSafeNumber(parsed?.totalQuestionsAnswered))),
      currentStreak: Math.max(0, Math.floor(toSafeNumber(parsed?.currentStreak))),
      bestStreak: Math.max(0, Math.floor(toSafeNumber(parsed?.bestStreak))),
      categoryCounts: toSafeCategoryCounts(parsed?.categoryCounts),
      recentRounds: toSafeRecentRounds(parsed?.recentRounds),
      lastUpdatedAt:
        typeof parsed?.lastUpdatedAt === "string" && parsed.lastUpdatedAt
          ? parsed.lastUpdatedAt
          : null
    };
  } catch {
    return getDefaultQuizProfileStats();
  }
}

export function recordQuizRoundProgress({
  category,
  lemonsEarned,
  totalCorrect,
  totalQuestions,
  currentStreak,
  bestStreak,
  didWin = false
}) {
  if (typeof window === "undefined") {
    return getDefaultQuizProfileStats();
  }

  const current = readQuizProfileStats();
  const normalizedCategory =
    typeof category === "string" && category.trim() ? category.trim() : "Mixed";
  const safeTotalCorrect = Math.max(0, Math.floor(toSafeNumber(totalCorrect)));
  const safeTotalQuestions = Math.max(0, Math.floor(toSafeNumber(totalQuestions)));
  const roundAccuracy = safeTotalQuestions
    ? Math.round((safeTotalCorrect / safeTotalQuestions) * 100)
    : 0;

  const recentRound = {
    playedAt: new Date().toISOString(),
    category: normalizedCategory,
    lemonsEarned: Math.max(0, Math.floor(toSafeNumber(lemonsEarned))),
    accuracy: roundAccuracy,
    totalCorrect: safeTotalCorrect,
    totalQuestions: safeTotalQuestions
  };

  const nextCategoryCounts = {
    ...current.categoryCounts,
    [normalizedCategory]: (current.categoryCounts[normalizedCategory] ?? 0) + 1
  };

  const nextStats = {
    quizzesPlayed: current.quizzesPlayed + 1,
    quizzesWon: current.quizzesWon + (didWin ? 1 : 0),
    totalPoints:
      current.totalPoints +
      safeTotalCorrect * 10 +
      Math.max(0, Math.floor(toSafeNumber(lemonsEarned))),
    totalLemons: current.totalLemons + Math.max(0, Math.floor(toSafeNumber(lemonsEarned))),
    totalCorrectAnswers: current.totalCorrectAnswers + safeTotalCorrect,
    totalQuestionsAnswered: current.totalQuestionsAnswered + safeTotalQuestions,
    currentStreak: Math.max(0, Math.floor(toSafeNumber(currentStreak))),
    bestStreak: Math.max(current.bestStreak, Math.max(0, Math.floor(toSafeNumber(bestStreak)))),
    categoryCounts: nextCategoryCounts,
    recentRounds: [recentRound, ...current.recentRounds].slice(0, 8),
    lastUpdatedAt: new Date().toISOString()
  };

  try {
    window.localStorage.setItem(QUIZ_PROFILE_STATS_STORAGE_KEY, JSON.stringify(nextStats));
  } catch {
    return current;
  }

  return nextStats;
}

export function buildStatsSyncPayload(stats) {
  const safeStats = stats && typeof stats === "object" ? stats : getDefaultQuizProfileStats();
  const recentActivity = Array.isArray(safeStats.recentRounds)
    ? safeStats.recentRounds.map((round) => ({
        type: "quiz_result",
        title: `${round.category} quiz completed`,
        subtitle: `${round.totalCorrect}/${round.totalQuestions} correct · ${round.accuracy}% accuracy · +${round.lemonsEarned} lemons`,
        created_at: round.playedAt,
        metadata: {
          category: round.category,
          lemonsEarned: round.lemonsEarned,
          accuracy: round.accuracy,
          totalCorrect: round.totalCorrect,
          totalQuestions: round.totalQuestions
        }
      }))
    : [];

  return {
    quizzes_played: Math.max(0, Math.floor(toSafeNumber(safeStats.quizzesPlayed))),
    quizzes_won: Math.max(0, Math.floor(toSafeNumber(safeStats.quizzesWon))),
    total_points: Math.max(0, Math.floor(toSafeNumber(safeStats.totalPoints))),
    total_lemons: Math.max(0, Math.floor(toSafeNumber(safeStats.totalLemons))),
    total_correct_answers: Math.max(0, Math.floor(toSafeNumber(safeStats.totalCorrectAnswers))),
    total_questions_answered: Math.max(
      0,
      Math.floor(toSafeNumber(safeStats.totalQuestionsAnswered))
    ),
    current_streak: Math.max(0, Math.floor(toSafeNumber(safeStats.currentStreak))),
    best_streak: Math.max(0, Math.floor(toSafeNumber(safeStats.bestStreak))),
    category_counts: toSafeCategoryCounts(safeStats.categoryCounts),
    recent_activity: recentActivity
  };
}
