import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { readQuizProfileStats } from "../features/quiz/utils/quizProfileStats";

const PROFILE_META_STORAGE_KEY = "english_lemon_profile_meta";
const PROFILE_IDENTITY_STORAGE_KEY = "english_lemon_profile_identity";
const LEMONS_PER_LEVEL = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BIO_LENGTH = 180;
const MAX_AVATAR_FILE_SIZE = 1024 * 1024;
const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

const SEASON_REFERENCE_PLAYERS = [
  { id: "seed-1", username: "LexiPrime", totalLemons: 1690, quizzesPlayed: 238, accuracy: 92 },
  { id: "seed-2", username: "WordFalcon", totalLemons: 1455, quizzesPlayed: 211, accuracy: 89 },
  { id: "seed-3", username: "NorthFluent", totalLemons: 1310, quizzesPlayed: 194, accuracy: 87 },
  { id: "seed-4", username: "MinaScope", totalLemons: 1195, quizzesPlayed: 173, accuracy: 85 },
  { id: "seed-5", username: "CrispSyntax", totalLemons: 1110, quizzesPlayed: 161, accuracy: 84 },
  { id: "seed-6", username: "EchoReader", totalLemons: 995, quizzesPlayed: 149, accuracy: 82 },
  { id: "seed-7", username: "IvyPronounce", totalLemons: 910, quizzesPlayed: 132, accuracy: 80 },
  { id: "seed-8", username: "DeltaLingua", totalLemons: 865, quizzesPlayed: 126, accuracy: 79 },
  { id: "seed-9", username: "NovaIdiom", totalLemons: 790, quizzesPlayed: 113, accuracy: 77 },
  { id: "seed-10", username: "SlateCollocate", totalLemons: 715, quizzesPlayed: 98, accuracy: 75 },
  { id: "seed-11", username: "FluentRidge", totalLemons: 680, quizzesPlayed: 92, accuracy: 74 },
  { id: "seed-12", username: "VerbaSpark", totalLemons: 640, quizzesPlayed: 89, accuracy: 73 }
];

function toSafeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function formatNumber(value) {
  return NUMBER_FORMATTER.format(Math.max(0, Math.floor(toSafeNumber(value))));
}

function formatPercent(value) {
  return `${Math.max(0, Math.min(100, Math.round(toSafeNumber(value))))}%`;
}

function formatDate(value, { withTime = false } = {}) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "Recently";
  }

  const options = withTime
    ? {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      }
    : {
        year: "numeric",
        month: "short",
        day: "numeric"
      };

  return new Intl.DateTimeFormat(undefined, options).format(parsed);
}

function buildUserKey(user) {
  if (user?.id != null) {
    return `id:${user.id}`;
  }
  if (typeof user?.email === "string" && user.email.trim()) {
    return `email:${user.email.trim().toLowerCase()}`;
  }
  if (typeof user?.username === "string" && user.username.trim()) {
    return `username:${user.username.trim().toLowerCase()}`;
  }
  return "anonymous";
}

function readLocalStorageObject(key) {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function writeLocalStorageObject(key, value) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage write errors to keep profile UX resilient.
  }
}

function getOrCreateJoinedDate(user) {
  const userKey = buildUserKey(user);
  const meta = readLocalStorageObject(PROFILE_META_STORAGE_KEY);

  if (typeof meta[userKey] === "string" && meta[userKey]) {
    return meta[userKey];
  }

  const fallbackDate = new Date().toISOString();
  writeLocalStorageObject(PROFILE_META_STORAGE_KEY, {
    ...meta,
    [userKey]: fallbackDate
  });
  return fallbackDate;
}

function normalizeIdentity(value) {
  return {
    displayName:
      typeof value?.displayName === "string" && value.displayName.trim()
        ? value.displayName.trim()
        : "",
    email: typeof value?.email === "string" ? value.email.trim().toLowerCase() : "",
    bio: typeof value?.bio === "string" ? value.bio.trim() : "",
    avatarDataUrl:
      typeof value?.avatarDataUrl === "string" && value.avatarDataUrl.trim()
        ? value.avatarDataUrl
        : ""
  };
}

function readIdentityForUser(user) {
  const userKey = buildUserKey(user);
  const store = readLocalStorageObject(PROFILE_IDENTITY_STORAGE_KEY);
  return normalizeIdentity(store[userKey]);
}

function saveIdentityForUser(user, identity) {
  const userKey = buildUserKey(user);
  const store = readLocalStorageObject(PROFILE_IDENTITY_STORAGE_KEY);

  writeLocalStorageObject(PROFILE_IDENTITY_STORAGE_KEY, {
    ...store,
    [userKey]: normalizeIdentity(identity)
  });
}

function findFavoriteCategory(categoryCounts) {
  const entries = Object.entries(categoryCounts || {}).filter(([, count]) => count > 0);
  if (!entries.length) {
    return "Mixed";
  }

  const [favoriteCategory] = entries.sort((a, b) => b[1] - a[1])[0];
  return favoriteCategory;
}

function getInitials(username, email) {
  const source =
    typeof username === "string" && username.trim()
      ? username.trim()
      : typeof email === "string"
        ? email.split("@")[0]
        : "EL";

  const initials = source
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((chunk) => chunk[0]?.toUpperCase() ?? "")
    .join("");

  return initials || "EL";
}

function getNextStreakTarget(currentStreak) {
  const milestones = [3, 5, 7, 10, 14, 21, 30];
  const next = milestones.find((value) => value > currentStreak);
  if (next) {
    return next;
  }

  return currentStreak + 5;
}

function buildValidationErrors(formValues) {
  const errors = {};
  const displayName = formValues.displayName?.trim() ?? "";
  const email = formValues.email?.trim() ?? "";
  const bio = formValues.bio?.trim() ?? "";

  if (!displayName) {
    errors.displayName = "Display name is required.";
  } else if (displayName.length < 2) {
    errors.displayName = "Display name should be at least 2 characters.";
  } else if (displayName.length > 40) {
    errors.displayName = "Display name should be 40 characters or fewer.";
  }

  if (!email) {
    errors.email = "Email is required.";
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.email = "Please enter a valid email address.";
  }

  if (bio.length > MAX_BIO_LENGTH) {
    errors.bio = `Bio should be ${MAX_BIO_LENGTH} characters or fewer.`;
  }

  return errors;
}

function areIdentitiesEqual(first, second) {
  const firstNormalized = normalizeIdentity(first);
  const secondNormalized = normalizeIdentity(second);

  return (
    firstNormalized.displayName === secondNormalized.displayName &&
    firstNormalized.email === secondNormalized.email &&
    firstNormalized.bio === secondNormalized.bio &&
    firstNormalized.avatarDataUrl === secondNormalized.avatarDataUrl
  );
}

function buildSeasonRankSnapshot(stats) {
  const currentPlayer = {
    id: "current-user",
    username: "You",
    totalLemons: Math.max(0, Math.floor(toSafeNumber(stats.totalLemons))),
    quizzesPlayed: Math.max(0, Math.floor(toSafeNumber(stats.quizzesPlayed))),
    accuracy: Math.max(0, Math.min(100, Math.round(toSafeNumber(stats.accuracy)))),
    isCurrentUser: true
  };

  const rows = [...SEASON_REFERENCE_PLAYERS, currentPlayer]
    .sort((first, second) => {
      if (second.totalLemons !== first.totalLemons) {
        return second.totalLemons - first.totalLemons;
      }
      if (second.accuracy !== first.accuracy) {
        return second.accuracy - first.accuracy;
      }
      if (second.quizzesPlayed !== first.quizzesPlayed) {
        return second.quizzesPlayed - first.quizzesPlayed;
      }
      return first.username.localeCompare(second.username);
    })
    .map((entry, index) => ({
      ...entry,
      rank: index + 1
    }));

  const currentRow = rows.find((entry) => entry.isCurrentUser);
  if (!currentRow) {
    return null;
  }

  const safePlayers = Math.max(rows.length, 1);
  const percentile = Math.max(1, Math.round(((safePlayers - currentRow.rank + 1) / safePlayers) * 100));

  return {
    rank: currentRow.rank,
    totalPlayers: safePlayers,
    percentile
  };
}

function getCompetitiveTier({ quizzesPlayed, totalLemons, accuracy, bestStreak }) {
  if (quizzesPlayed < 3) {
    return {
      label: "Rising Learner",
      message: "Complete a few more rounds to lock your competitive identity."
    };
  }

  if (totalLemons >= 1200 && accuracy >= 88 && bestStreak >= 8) {
    return {
      label: "Elite Challenger",
      message: "Your profile signals top-tier consistency this season."
    };
  }

  if (totalLemons >= 700 && accuracy >= 80) {
    return {
      label: "Competitive Climber",
      message: "Strong form. Keep pressure on the board leaders."
    };
  }

  if (totalLemons >= 300 || bestStreak >= 4) {
    return {
      label: "Momentum Builder",
      message: "You are building reliable growth with every session."
    };
  }

  return {
    label: "Rising Learner",
    message: "Early progress is in place. Stay active to accelerate quickly."
  };
}

function buildMotivationCopy({
  quizzesPlayed,
  accuracy,
  currentStreak,
  totalLemons,
  unlockedAchievements,
  seasonRankSnapshot
}) {
  if (!quizzesPlayed) {
    return {
      headline: "Your profile is ready to launch.",
      message: "Start your first quiz round to enter the season board and begin earning milestones."
    };
  }

  if (seasonRankSnapshot?.rank && seasonRankSnapshot.rank <= 3) {
    return {
      headline: "You are in podium territory.",
      message: "Defend your position before the season reset and keep your edge alive."
    };
  }

  if (accuracy >= 88 && unlockedAchievements >= 4) {
    return {
      headline: "High precision, high momentum.",
      message: "Your profile is trending like a top competitor. Keep converting rounds into lemons."
    };
  }

  if (currentStreak >= 5) {
    return {
      headline: "Streak energy is active.",
      message: "Consistency is your advantage right now. Stay locked in and climb while momentum lasts."
    };
  }

  if (totalLemons >= 250) {
    return {
      headline: "Progress is getting noticeable.",
      message: "You are stacking meaningful rewards. Push a few strong sessions for a bigger jump."
    };
  }

  return {
    headline: "Keep your growth loop active.",
    message: "Each session sharpens your stats. Keep showing up and your profile will compound."
  };
}

function buildAchievementProgressLabel(achievement) {
  if (achievement.id === "sharp_accuracy") {
    return `${formatPercent(achievement.current)} / ${achievement.target}%`;
  }

  return `${formatNumber(achievement.current)} / ${formatNumber(achievement.target)}`;
}

function ProfilePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const saveTimerRef = useRef(null);
  const avatarInputRef = useRef(null);
  const displayNameInputRef = useRef(null);

  const [joinedDate, setJoinedDate] = useState(null);
  const [identity, setIdentity] = useState({
    displayName: "",
    email: "",
    bio: "",
    avatarDataUrl: ""
  });
  const [formValues, setFormValues] = useState(identity);
  const [formErrors, setFormErrors] = useState({});
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState("");

  useEffect(() => {
    const initialIdentity = normalizeIdentity({
      displayName: user?.username ?? "Learner",
      email: user?.email ?? "",
      ...readIdentityForUser(user)
    });

    setJoinedDate(getOrCreateJoinedDate(user));
    setIdentity(initialIdentity);
    setFormValues(initialIdentity);
    setFormErrors({});
  }, [user]);

  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (!isEditOpen) {
      return undefined;
    }

    const onKeyDown = (event) => {
      if (event.key === "Escape" && !isSaving) {
        setIsEditOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isEditOpen, isSaving]);

  useEffect(() => {
    if (!isEditOpen) {
      return undefined;
    }

    const frame = window.requestAnimationFrame(() => {
      displayNameInputRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, [isEditOpen]);

  const quizStats = useMemo(() => readQuizProfileStats(), [user?.id, user?.email]);

  const profileStats = useMemo(() => {
    const quizzesPlayed = Math.max(0, Math.floor(toSafeNumber(quizStats.quizzesPlayed)));
    const totalLemons = Math.max(0, Math.floor(toSafeNumber(quizStats.totalLemons)));
    const currentStreak = Math.max(0, Math.floor(toSafeNumber(quizStats.currentStreak)));
    const bestStreak = Math.max(0, Math.floor(toSafeNumber(quizStats.bestStreak)));
    const totalCorrectAnswers = Math.max(0, Math.floor(toSafeNumber(quizStats.totalCorrectAnswers)));
    const totalQuestionsAnswered = Math.max(
      0,
      Math.floor(toSafeNumber(quizStats.totalQuestionsAnswered))
    );
    const accuracy = totalQuestionsAnswered
      ? Math.round((totalCorrectAnswers / totalQuestionsAnswered) * 100)
      : 0;
    const wrongAnswers = Math.max(0, totalQuestionsAnswered - totalCorrectAnswers);
    const favoriteCategory = findFavoriteCategory(quizStats.categoryCounts);
    const categoriesExplored = Object.keys(quizStats.categoryCounts ?? {}).length;
    const averageLemonsPerQuiz = quizzesPlayed ? Math.round(totalLemons / quizzesPlayed) : 0;
    const consistencyScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(accuracy * 0.65 + (Math.min(bestStreak, 20) / 20) * 35)
      )
    );
    const recentRounds = Array.isArray(quizStats.recentRounds) ? quizStats.recentRounds : [];
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const roundsLast7Days = recentRounds.filter((round) => {
      const playedAt = new Date(round.playedAt).getTime();
      return Number.isFinite(playedAt) && playedAt >= sevenDaysAgo;
    }).length;
    const recentBestAccuracy = recentRounds.length
      ? Math.max(...recentRounds.slice(0, 5).map((round) => toSafeNumber(round.accuracy)))
      : 0;

    return {
      quizzesPlayed,
      totalLemons,
      accuracy,
      wrongAnswers,
      currentStreak,
      bestStreak,
      favoriteCategory,
      categoriesExplored,
      totalCorrectAnswers,
      totalQuestionsAnswered,
      averageLemonsPerQuiz,
      consistencyScore,
      roundsLast7Days,
      recentBestAccuracy,
      recentRounds
    };
  }, [quizStats]);

  const levelData = useMemo(() => {
    const safeLemons = Math.max(0, profileStats.totalLemons);
    const level = Math.floor(safeLemons / LEMONS_PER_LEVEL) + 1;
    const levelBase = (level - 1) * LEMONS_PER_LEVEL;
    const nextLevelTarget = level * LEMONS_PER_LEVEL;
    const lemonsToNext = Math.max(0, nextLevelTarget - safeLemons);
    const levelProgress = Math.round(((safeLemons - levelBase) / LEMONS_PER_LEVEL) * 100);
    const streakTarget = getNextStreakTarget(profileStats.currentStreak);
    const streakProgress = Math.min(
      100,
      Math.round((profileStats.currentStreak / Math.max(1, streakTarget)) * 100)
    );

    return {
      level,
      levelProgress,
      nextLevelTarget,
      lemonsToNext,
      streakTarget,
      streakProgress
    };
  }, [profileStats.currentStreak, profileStats.totalLemons]);

  const seasonRankSnapshot = useMemo(() => buildSeasonRankSnapshot(profileStats), [profileStats]);
  const tier = useMemo(() => getCompetitiveTier(profileStats), [profileStats]);

  const achievements = useMemo(
    () => [
      {
        id: "first_quiz",
        label: "First Quiz Completed",
        current: profileStats.quizzesPlayed,
        target: 1,
        unlocked: profileStats.quizzesPlayed >= 1
      },
      {
        id: "quiz_rhythm",
        label: "10 Quiz Sessions",
        current: profileStats.quizzesPlayed,
        target: 10,
        unlocked: profileStats.quizzesPlayed >= 10
      },
      {
        id: "sharp_accuracy",
        label: "80% Accuracy",
        current: profileStats.accuracy,
        target: 80,
        unlocked: profileStats.accuracy >= 80 && profileStats.quizzesPlayed >= 3
      },
      {
        id: "streak_builder",
        label: "5x Streak",
        current: profileStats.bestStreak,
        target: 5,
        unlocked: profileStats.bestStreak >= 5
      },
      {
        id: "lemon_collector",
        label: "200 Lemons",
        current: profileStats.totalLemons,
        target: 200,
        unlocked: profileStats.totalLemons >= 200
      },
      {
        id: "category_explorer",
        label: "3 Categories Explored",
        current: profileStats.categoriesExplored,
        target: 3,
        unlocked: profileStats.categoriesExplored >= 3
      }
    ],
    [profileStats]
  );

  const unlockedAchievements = useMemo(
    () => achievements.filter((achievement) => achievement.unlocked).length,
    [achievements]
  );
  const achievementCompletion = Math.round((unlockedAchievements / achievements.length) * 100);
  const nextAchievement = achievements.find((achievement) => !achievement.unlocked) ?? null;
  const nextAchievementProgress = nextAchievement
    ? Math.min(100, Math.round((nextAchievement.current / Math.max(1, nextAchievement.target)) * 100))
    : 100;
  const nextAchievementRemaining = nextAchievement
    ? Math.max(0, nextAchievement.target - nextAchievement.current)
    : 0;

  const motivation = useMemo(
    () =>
      buildMotivationCopy({
        ...profileStats,
        unlockedAchievements,
        seasonRankSnapshot
      }),
    [profileStats, seasonRankSnapshot, unlockedAchievements]
  );

  const profileValidationErrors = useMemo(() => buildValidationErrors(formValues), [formValues]);
  const hasChanges = useMemo(() => !areIdentitiesEqual(formValues, identity), [formValues, identity]);
  const isSaveDisabled = isSaving || !hasChanges || Object.keys(profileValidationErrors).length > 0;

  const displayName = identity.displayName || "Learner";
  const email = identity.email || "No email available";
  const initials = getInitials(displayName, email);

  const openEditProfile = () => {
    setFormValues(identity);
    setFormErrors({});
    setSaveFeedback("");
    setIsEditOpen(true);
  };

  const closeEditProfile = () => {
    if (isSaving) {
      return;
    }
    setIsEditOpen(false);
    setFormErrors({});
    setFormValues(identity);
  };

  const handleFieldChange = (field, value) => {
    setFormValues((previous) => ({
      ...previous,
      [field]: value
    }));
    setFormErrors((previous) => {
      if (!previous[field]) {
        return previous;
      }
      const next = { ...previous };
      delete next[field];
      return next;
    });
  };

  const handleFieldBlur = (field) => {
    const errors = buildValidationErrors(formValues);
    setFormErrors((previous) => {
      const next = { ...previous };
      if (errors[field]) {
        next[field] = errors[field];
      } else {
        delete next[field];
      }
      return next;
    });
  };

  const handleAvatarUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setFormErrors((previous) => ({
        ...previous,
        avatarDataUrl: "Please choose an image file."
      }));
      event.target.value = "";
      return;
    }

    if (file.size > MAX_AVATAR_FILE_SIZE) {
      setFormErrors((previous) => ({
        ...previous,
        avatarDataUrl: "Image should be 1MB or smaller."
      }));
      event.target.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setFormValues((previous) => ({
        ...previous,
        avatarDataUrl: typeof reader.result === "string" ? reader.result : previous.avatarDataUrl
      }));
      setFormErrors((previous) => {
        const next = { ...previous };
        delete next.avatarDataUrl;
        return next;
      });
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  };

  const handleRemoveAvatar = () => {
    setFormValues((previous) => ({
      ...previous,
      avatarDataUrl: ""
    }));
    setFormErrors((previous) => {
      const next = { ...previous };
      delete next.avatarDataUrl;
      return next;
    });
  };

  const handleSaveProfile = (event) => {
    event.preventDefault();
    const errors = buildValidationErrors(formValues);
    setFormErrors(errors);

    if (Object.keys(errors).length) {
      return;
    }

    setIsSaving(true);

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    const nextIdentity = normalizeIdentity(formValues);

    saveTimerRef.current = window.setTimeout(() => {
      setIdentity(nextIdentity);
      saveIdentityForUser(user, nextIdentity);
      setIsSaving(false);
      setIsEditOpen(false);
      setSaveFeedback(`Profile updated ${formatDate(new Date().toISOString(), { withTime: true })}.`);
    }, 520);
  };

  return (
    <main className="page-shell profile-page">
      <section className="profile-shell">
        <header className="profile-header">
          <div>
            <div className="brand-mark">English Lemon</div>
            <h1>Player Profile</h1>
            <p className="dashboard-subtitle">
              Your identity, competitive momentum, achievements, and performance progression in one
              premium player dashboard.
            </p>
          </div>
          <button
            type="button"
            className="secondary-btn profile-nav-btn"
            onClick={() => navigate("/dashboard")}
          >
            Back to Dashboard
          </button>
        </header>

        {saveFeedback ? (
          <p className="profile-save-feedback" aria-live="polite">
            {saveFeedback}
          </p>
        ) : null}

        <section className="profile-hero-grid">
          <article className="feature-card profile-hero-card">
            <div className="profile-avatar-wrap">
              <div className={`profile-avatar ${identity.avatarDataUrl ? "has-image" : ""}`}>
                {identity.avatarDataUrl ? (
                  <img src={identity.avatarDataUrl} alt={`${displayName} avatar`} />
                ) : (
                  initials
                )}
              </div>
              <span className="profile-level-pill">Level {levelData.level}</span>
              <span className="profile-level-pill">{tier.label}</span>
            </div>

            <div className="profile-hero-copy">
              <p className="profile-name">{displayName}</p>
              <p className="profile-email">{email}</p>
              <div className="profile-meta-row">
                <span>Joined {formatDate(joinedDate)}</span>
                {profileStats.recentRounds[0]?.playedAt ? (
                  <span>
                    Last active {formatDate(profileStats.recentRounds[0].playedAt, { withTime: true })}
                  </span>
                ) : null}
                {seasonRankSnapshot ? (
                  <span>
                    Season rank #{seasonRankSnapshot.rank} / {seasonRankSnapshot.totalPlayers}
                  </span>
                ) : null}
              </div>
              <p className="profile-bio">
                {identity.bio || "Focused on steady growth, better accuracy, and strong streak discipline."}
              </p>
            </div>

            <div className="profile-hero-highlights">
              <article>
                <span>Total Lemons</span>
                <strong>🍋 {formatNumber(profileStats.totalLemons)}</strong>
              </article>
              <article>
                <span>Current Streak</span>
                <strong>{formatNumber(profileStats.currentStreak)}x</strong>
              </article>
              <article>
                <span>Season Position</span>
                <strong>
                  {seasonRankSnapshot
                    ? `#${seasonRankSnapshot.rank} (${seasonRankSnapshot.percentile}th pct)`
                    : "Unranked"}
                </strong>
              </article>
              <article>
                <span>Achievements</span>
                <strong>
                  {formatNumber(unlockedAchievements)} / {formatNumber(achievements.length)}
                </strong>
              </article>
            </div>

            <div className="profile-identity-actions">
              <button
                type="button"
                className="secondary-btn profile-edit-btn"
                onClick={openEditProfile}
              >
                Edit Profile
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => navigate("/leaderboard")}
              >
                View Leaderboard
              </button>
              <span className="profile-edit-hint">{tier.message}</span>
            </div>
          </article>

          <article className="feature-card profile-motivation-card">
            <p className="profile-motivation-label">Competitive Pulse</p>
            <p className="profile-motivation-message">{motivation.headline}</p>
            <p className="profile-motivation-subtle">{motivation.message}</p>
            <div className="profile-motivation-pills">
              <span>{formatPercent(profileStats.accuracy)} Accuracy</span>
              <span>{formatNumber(profileStats.quizzesPlayed)} Quizzes</span>
              <span>{formatNumber(profileStats.averageLemonsPerQuiz)} Lemons / Quiz</span>
              <span>{formatNumber(profileStats.roundsLast7Days)} Rounds in 7 Days</span>
            </div>
          </article>
        </section>

        <section className="profile-stats-grid">
          <article className="feature-card profile-stat-card is-lemons">
            <span>Total Lemons</span>
            <strong>{formatNumber(profileStats.totalLemons)}</strong>
          </article>
          <article className="feature-card profile-stat-card">
            <span>Quizzes Played</span>
            <strong>{formatNumber(profileStats.quizzesPlayed)}</strong>
          </article>
          <article className="feature-card profile-stat-card">
            <span>Accuracy</span>
            <strong>{formatPercent(profileStats.accuracy)}</strong>
          </article>
          <article className="feature-card profile-stat-card">
            <span>Consistency Score</span>
            <strong>{formatPercent(profileStats.consistencyScore)}</strong>
          </article>
          <article className="feature-card profile-stat-card">
            <span>Current Streak</span>
            <strong>{formatNumber(profileStats.currentStreak)}x</strong>
          </article>
          <article className="feature-card profile-stat-card">
            <span>Best Streak</span>
            <strong>{formatNumber(profileStats.bestStreak)}x</strong>
          </article>
          <article className="feature-card profile-stat-card">
            <span>Season Rank</span>
            <strong>{seasonRankSnapshot ? `#${seasonRankSnapshot.rank}` : "--"}</strong>
          </article>
          <article className="feature-card profile-stat-card">
            <span>Favorite Category</span>
            <strong className="profile-category-badge">{profileStats.favoriteCategory}</strong>
          </article>
        </section>

        <section className="profile-progress-grid">
          <article className="feature-card profile-progress-card">
            <p className="profile-progress-title">Next Level</p>
            <div className="profile-progress-headline">
              <strong>Level {levelData.level}</strong>
              <span>{formatNumber(levelData.lemonsToNext)} lemons to Level {levelData.level + 1}</span>
            </div>
            <div
              className="profile-progress-track"
              role="progressbar"
              aria-valuenow={levelData.levelProgress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="profile-progress-fill" style={{ width: `${levelData.levelProgress}%` }} />
            </div>
            <p className="profile-progress-footnote">
              Target: {formatNumber(levelData.nextLevelTarget)} total lemons
            </p>
          </article>

          <article className="feature-card profile-progress-card">
            <p className="profile-progress-title">Streak Milestone</p>
            <div className="profile-progress-headline">
              <strong>{formatNumber(profileStats.currentStreak)}x current</strong>
              <span>
                {formatNumber(Math.max(0, levelData.streakTarget - profileStats.currentStreak))} to{" "}
                {formatNumber(levelData.streakTarget)}x
              </span>
            </div>
            <div
              className="profile-progress-track"
              role="progressbar"
              aria-valuenow={levelData.streakProgress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="profile-progress-fill is-cool" style={{ width: `${levelData.streakProgress}%` }} />
            </div>
            <p className="profile-progress-footnote">Keep your daily rhythm alive to unlock this milestone.</p>
          </article>

          <article className="feature-card profile-progress-card">
            <p className="profile-progress-title">Achievement Progress</p>
            <div className="profile-progress-headline">
              <strong>
                {formatNumber(unlockedAchievements)} / {formatNumber(achievements.length)} unlocked
              </strong>
              <span>{formatPercent(achievementCompletion)} complete</span>
            </div>
            <div
              className="profile-progress-track"
              role="progressbar"
              aria-valuenow={achievementCompletion}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="profile-progress-fill" style={{ width: `${achievementCompletion}%` }} />
            </div>
            <p className="profile-progress-footnote">
              {nextAchievement
                ? `Next: ${nextAchievement.label} (${buildAchievementProgressLabel(
                    nextAchievement
                  )}, ${formatNumber(nextAchievementRemaining)} remaining)`
                : "All current milestones unlocked. Keep climbing before the season reset."}
            </p>
          </article>

          <article className="feature-card profile-progress-card">
            <p className="profile-progress-title">Season Momentum</p>
            <div className="profile-progress-headline">
              <strong>
                {seasonRankSnapshot
                  ? `Ahead of ${formatNumber(seasonRankSnapshot.percentile)}%`
                  : "Build your standing"}
              </strong>
              <span>{formatNumber(profileStats.roundsLast7Days)} rounds this week</span>
            </div>
            <div
              className="profile-progress-track"
              role="progressbar"
              aria-valuenow={nextAchievementProgress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="profile-progress-fill is-cool" style={{ width: `${nextAchievementProgress}%` }} />
            </div>
            <p className="profile-progress-footnote">
              Rankings reset each season. This is the best window to climb your position.
            </p>
          </article>
        </section>

        <section className="profile-bottom-grid">
          <article className="feature-card profile-activity-card">
            <p className="profile-section-title">Recent Activity</p>
            <p className="profile-empty-copy">
              Last 5 rounds. Best recent accuracy: {formatPercent(profileStats.recentBestAccuracy)}.
            </p>
            {profileStats.recentRounds.length ? (
              <ul className="profile-activity-list">
                {profileStats.recentRounds.slice(0, 5).map((round, index) => (
                  <li key={`${round.playedAt}-${round.category}-${index}`}>
                    <div>
                      <strong>{round.category}</strong>
                      <span>{formatDate(round.playedAt, { withTime: true })}</span>
                    </div>
                    <div className="profile-activity-metrics">
                      <span>
                        {formatNumber(round.totalCorrect)}/{formatNumber(round.totalQuestions)}
                      </span>
                      <span>{formatPercent(round.accuracy)}</span>
                      <span>🍋 +{formatNumber(round.lemonsEarned)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="profile-empty-copy">
                Complete a quiz round to populate your recent activity timeline.
              </p>
            )}
          </article>

          <article className="feature-card profile-achievements-card">
            <p className="profile-section-title">Milestones</p>
            <p className="profile-empty-copy">
              Unlock milestones to strengthen your profile identity and progression record.
            </p>
            <ul className="profile-achievements-list">
              {achievements.map((achievement) => (
                <li key={achievement.id} className={achievement.unlocked ? "is-unlocked" : "is-locked"}>
                  <span>
                    {achievement.label}
                    {!achievement.unlocked ? ` (${buildAchievementProgressLabel(achievement)})` : ""}
                  </span>
                  <strong>{achievement.unlocked ? "Unlocked" : "In Progress"}</strong>
                </li>
              ))}
            </ul>
          </article>
        </section>
      </section>

      <div
        className={`profile-edit-overlay ${isEditOpen ? "is-open" : ""}`}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            closeEditProfile();
          }
        }}
        aria-hidden={!isEditOpen}
      >
        <section className="profile-edit-panel" aria-modal="true" role="dialog">
          <header className="profile-edit-header">
            <h2>Edit Profile</h2>
            <p>Update your player identity for the English Lemon platform.</p>
            <p className="profile-motivation-subtle">
              {hasChanges ? "You have unsaved changes." : "All details are currently saved."}
            </p>
          </header>

          <form className="profile-edit-form" onSubmit={handleSaveProfile}>
            <div className="profile-edit-avatar-row">
              <div className={`profile-avatar profile-avatar-edit ${formValues.avatarDataUrl ? "has-image" : ""}`}>
                {formValues.avatarDataUrl ? (
                  <img src={formValues.avatarDataUrl} alt="Profile avatar preview" />
                ) : (
                  getInitials(formValues.displayName || displayName, formValues.email || email)
                )}
              </div>
              <div className="profile-edit-avatar-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => avatarInputRef.current?.click()}
                >
                  Upload Avatar
                </button>
                {formValues.avatarDataUrl ? (
                  <button
                    type="button"
                    className="secondary-btn profile-avatar-remove-btn"
                    onClick={handleRemoveAvatar}
                  >
                    Remove
                  </button>
                ) : null}
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleAvatarUpload}
                  className="sr-only"
                />
                {formErrors.avatarDataUrl ? (
                  <p className="profile-field-error">{formErrors.avatarDataUrl}</p>
                ) : null}
              </div>
            </div>

            <div className="profile-edit-grid">
              <label className="profile-field">
                <span>Display Name</span>
                <input
                  ref={displayNameInputRef}
                  type="text"
                  value={formValues.displayName}
                  onChange={(event) => handleFieldChange("displayName", event.target.value)}
                  onBlur={() => handleFieldBlur("displayName")}
                  placeholder="Your display name"
                  required
                />
                <div className="profile-field-footnote">
                  <span>Used across dashboard, leaderboard, and activity.</span>
                </div>
                {formErrors.displayName ? (
                  <p className="profile-field-error">{formErrors.displayName}</p>
                ) : null}
              </label>

              <label className="profile-field">
                <span>Email</span>
                <input
                  type="email"
                  value={formValues.email}
                  onChange={(event) => handleFieldChange("email", event.target.value)}
                  onBlur={() => handleFieldBlur("email")}
                  placeholder="you@example.com"
                  required
                />
                <div className="profile-field-footnote">
                  <span>Used for account identity and notifications later.</span>
                </div>
                {formErrors.email ? <p className="profile-field-error">{formErrors.email}</p> : null}
              </label>
            </div>

            <label className="profile-field">
              <span>Bio</span>
              <textarea
                value={formValues.bio}
                onChange={(event) => handleFieldChange("bio", event.target.value)}
                onBlur={() => handleFieldBlur("bio")}
                placeholder="Share your current learning focus, streak goal, or category target."
                maxLength={MAX_BIO_LENGTH}
                rows={3}
              />
              <div className="profile-field-footnote">
                <span>
                  {formatNumber(formValues.bio.length)}/{formatNumber(MAX_BIO_LENGTH)}
                </span>
                {formErrors.bio ? <p className="profile-field-error">{formErrors.bio}</p> : null}
              </div>
            </label>

            <div className="profile-motivation-pills">
              <span>Preview: {formValues.displayName || "Display Name"}</span>
              <span>{formValues.email || "email@domain.com"}</span>
              <span>{formValues.bio ? "Bio Added" : "No Bio Yet"}</span>
            </div>

            <footer className="profile-edit-actions">
              <button
                type="button"
                className="secondary-btn"
                onClick={closeEditProfile}
                disabled={isSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => {
                  setFormValues(identity);
                  setFormErrors({});
                }}
                disabled={isSaving || !hasChanges}
              >
                Reset
              </button>
              <button
                type="submit"
                className="primary-btn profile-save-btn"
                disabled={isSaveDisabled}
              >
                {isSaving ? "Saving..." : "Save Changes"}
              </button>
            </footer>
          </form>
        </section>
      </div>
    </main>
  );
}

export default ProfilePage;
