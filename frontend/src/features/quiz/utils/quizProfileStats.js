const QUIZ_PROFILE_STATS_STORAGE_KEY = "english_lemon_quiz_profile_stats";

const DEFAULT_QUIZ_PROFILE_STATS = {
  quizzesPlayed: 0,
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
  bestStreak
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
