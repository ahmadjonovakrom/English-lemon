import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import NotificationBell from "../components/notifications/NotificationBell";
import {
  getMyActivity,
  getMyProfile,
  getMyStats,
  getPublicActivity,
  getPublicProfile,
  getPublicStats,
  syncMyStats,
  updateMyProfile
} from "../api/profile";
import {
  acceptFriendRequest,
  cancelFriendRequest,
  createOrGetDirectConversation,
  declineFriendRequest,
  sendFriendRequest
} from "../api/social";
import { useAuth } from "../context/AuthContext";
import {
  buildStatsSyncPayload,
  readQuizProfileStats
} from "../features/quiz/utils/quizProfileStats";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BIO_LENGTH = 240;
const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

function formatNumber(value) {
  return NUMBER_FORMATTER.format(Math.max(0, Math.floor(Number(value) || 0)));
}

function formatPercent(value) {
  return `${Math.max(0, Math.min(100, Math.round(Number(value) || 0)))}%`;
}

function formatDate(value, { withTime = false } = {}) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "Recently";
  }

  const options = withTime
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(undefined, options).format(parsed);
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
  return formatDate(parsed.toISOString());
}

function getInitials(displayName, username, email) {
  const source =
    (typeof displayName === "string" && displayName.trim()) ||
    (typeof username === "string" && username.trim()) ||
    (typeof email === "string" && email.split("@")[0]) ||
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

function buildValidationErrors(values) {
  const errors = {};
  const displayName = values.display_name?.trim() ?? "";
  const username = values.username?.trim() ?? "";
  const email = values.email?.trim() ?? "";
  const bio = values.bio?.trim() ?? "";

  if (!displayName) {
    errors.display_name = "Display name is required.";
  } else if (displayName.length < 2) {
    errors.display_name = "Display name should be at least 2 characters.";
  }

  if (!username) {
    errors.username = "Username is required.";
  } else if (username.length < 3) {
    errors.username = "Username should be at least 3 characters.";
  }

  if (email && !EMAIL_PATTERN.test(email)) {
    errors.email = "Email is not valid.";
  }

  if (bio.length > MAX_BIO_LENGTH) {
    errors.bio = `Bio should be ${MAX_BIO_LENGTH} characters or fewer.`;
  }

  return errors;
}

function profileValuesFromPayload(profile) {
  return {
    display_name: profile?.display_name ?? "",
    username: profile?.username ?? "",
    email: profile?.email ?? "",
    bio: profile?.bio ?? "",
    avatar_url: profile?.avatar_url ?? ""
  };
}

function getCompetitiveTier(stats) {
  if (!stats.quizzes_played) {
    return {
      label: "Rising Learner",
      message: "Start a few quiz rounds to activate your progression profile."
    };
  }
  if ((stats.rank ?? 999) <= 10 && stats.accuracy_percentage >= 85) {
    return {
      label: "Elite Challenger",
      message: "You are holding premium competitive form right now."
    };
  }
  if (stats.lemons_balance >= 300 || stats.streak >= 5) {
    return {
      label: "Momentum Builder",
      message: "Your profile shows strong upward motion across recent sessions."
    };
  }
  return {
    label: "Competitive Climber",
    message: "Keep stacking rounds and your identity will sharpen fast."
  };
}

function buildMotivationCopy(stats) {
  if (!stats.quizzes_played) {
    return {
      headline: "Your player profile is ready to launch.",
      message: "Finish your next quiz round to unlock progression, rank, and achievement momentum."
    };
  }
  if ((stats.rank ?? 999) <= 3) {
    return {
      headline: "You are in podium range.",
      message: "Protect your position and keep pressing before the season standings shift."
    };
  }
  if (stats.streak >= 5) {
    return {
      headline: "Your streak is doing real work.",
      message: "Consistency is currently your strongest edge. Keep showing up while the rhythm is active."
    };
  }
  if (stats.accuracy_percentage >= 80) {
    return {
      headline: "High-accuracy sessions are compounding.",
      message: "You are converting clean answers into real leaderboard pressure."
    };
  }
  return {
    headline: "Progress is building under the surface.",
    message: "Your next few sessions can turn this profile into something noticeably stronger."
  };
}

function buildProgressCards(stats) {
  const xpProgress = stats.xp_for_next_level
    ? Math.round((stats.xp_into_level / stats.xp_for_next_level) * 100)
    : 0;
  const nextStreakTarget = stats.streak < 3 ? 3 : stats.streak < 7 ? 7 : stats.streak + 3;
  const streakProgress = Math.min(100, Math.round((stats.streak / Math.max(1, nextStreakTarget)) * 100));
  const unlocked = stats.achievements.filter((achievement) => achievement.unlocked).length;
  const achievementCompletion = stats.achievements.length
    ? Math.round((unlocked / stats.achievements.length) * 100)
    : 0;

  return {
    xpProgress,
    nextStreakTarget,
    streakProgress,
    unlocked,
    achievementCompletion
  };
}

function emptyStats(userId = 0) {
  return {
    user_id: userId,
    level: 1,
    xp: 0,
    xp_into_level: 0,
    xp_for_next_level: 300,
    lemons_balance: 0,
    streak: 0,
    best_streak: 0,
    total_points: 0,
    quizzes_played: 0,
    quizzes_won: 0,
    correct_answers: 0,
    total_questions_answered: 0,
    accuracy_percentage: 0,
    favorite_category: null,
    categories_explored: 0,
    rank: null,
    recent_activity: [],
    achievements: []
  };
}

function ProfilePage() {
  const navigate = useNavigate();
  const { userId } = useParams();
  const { user, refreshUser } = useAuth();
  const saveTimerRef = useRef(null);

  const viewingOwnProfile = !userId || String(userId) === String(user?.id);
  const numericUserId = userId ? Number(userId) : null;

  const [profile, setProfile] = useState(null);
  const [stats, setStats] = useState(emptyStats());
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState("");
  const [formValues, setFormValues] = useState(profileValuesFromPayload(null));
  const [formErrors, setFormErrors] = useState({});
  const [socialActionLoading, setSocialActionLoading] = useState("");

  useEffect(
    () => () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    let isMounted = true;

    const loadProfile = async () => {
      if (!viewingOwnProfile && !Number.isFinite(numericUserId)) {
        setLoading(false);
        setError("User profile was not found.");
        return;
      }

      setLoading(true);
      setError("");

      try {
        let profileResponse;
        let statsResponse;
        let activityResponse;

        if (viewingOwnProfile) {
          [profileResponse, statsResponse, activityResponse] = await Promise.all([
            getMyProfile(),
            getMyStats(),
            getMyActivity()
          ]);

          const localStats = readQuizProfileStats();
          const needsSync =
            (localStats?.quizzesPlayed ?? 0) > (statsResponse?.quizzes_played ?? 0) ||
            (localStats?.totalLemons ?? 0) > (statsResponse?.lemons_balance ?? 0) ||
            (localStats?.totalPoints ?? 0) > (statsResponse?.total_points ?? 0);

          if (needsSync) {
            statsResponse = await syncMyStats(buildStatsSyncPayload(localStats));
            activityResponse = { items: statsResponse?.recent_activity ?? [] };
          }
        } else {
          [profileResponse, statsResponse, activityResponse] = await Promise.all([
            getPublicProfile(numericUserId),
            getPublicStats(numericUserId),
            getPublicActivity(numericUserId)
          ]);
        }

        if (!isMounted) {
          return;
        }

        setProfile(profileResponse);
        setStats({ ...emptyStats(profileResponse?.id), ...statsResponse });
        setActivity(Array.isArray(activityResponse?.items) ? activityResponse.items : []);
        setFormValues(profileValuesFromPayload(profileResponse));
        setFormErrors({});
      } catch (loadError) {
        if (!isMounted) {
          return;
        }
        setError(loadError?.detail || loadError?.message || "Unable to load profile.");
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    void loadProfile();
    return () => {
      isMounted = false;
    };
  }, [numericUserId, viewingOwnProfile]);

  const validationErrors = useMemo(() => buildValidationErrors(formValues), [formValues]);
  const hasChanges = useMemo(() => {
    const original = profileValuesFromPayload(profile);
    return JSON.stringify(original) !== JSON.stringify(formValues);
  }, [formValues, profile]);

  const tier = useMemo(() => getCompetitiveTier(stats), [stats]);
  const motivation = useMemo(() => buildMotivationCopy(stats), [stats]);
  const progress = useMemo(() => buildProgressCards(stats), [stats]);
  const unlockedAchievements = stats.achievements.filter((achievement) => achievement.unlocked).length;
  const nextAchievement = stats.achievements.find((achievement) => !achievement.unlocked) ?? null;
  const initials = getInitials(profile?.display_name, profile?.username, profile?.email);
  const recentActivity = activity.length ? activity : stats.recent_activity;

  const handleOpenEdit = () => {
    setFormValues(profileValuesFromPayload(profile));
    setFormErrors({});
    setSaveFeedback("");
    setIsEditOpen(true);
  };

  const handleCloseEdit = () => {
    if (isSaving) {
      return;
    }
    setIsEditOpen(false);
    setFormErrors({});
    setFormValues(profileValuesFromPayload(profile));
  };

  const handleSaveProfile = async (event) => {
    event.preventDefault();
    const nextErrors = buildValidationErrors(formValues);
    setFormErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      return;
    }

    setIsSaving(true);
    try {
      const updated = await updateMyProfile({
        display_name: formValues.display_name.trim(),
        username: formValues.username.trim(),
        bio: formValues.bio.trim(),
        avatar_url: formValues.avatar_url.trim()
      });

      setProfile(updated);
      setFormValues(profileValuesFromPayload(updated));
      setIsEditOpen(false);
      setSaveFeedback(`Profile updated ${formatDate(new Date().toISOString(), { withTime: true })}.`);
      await refreshUser();
    } catch (saveError) {
      setFormErrors((previous) => ({
        ...previous,
        form: saveError?.detail || saveError?.message || "Unable to save profile."
      }));
    } finally {
      setIsSaving(false);
    }
  };

  const refreshPublicProfile = async () => {
    if (viewingOwnProfile || !numericUserId) {
      return;
    }

    const [profileResponse, statsResponse, activityResponse] = await Promise.all([
      getPublicProfile(numericUserId),
      getPublicStats(numericUserId),
      getPublicActivity(numericUserId)
    ]);
    setProfile(profileResponse);
    setStats({ ...emptyStats(profileResponse?.id), ...statsResponse });
    setActivity(Array.isArray(activityResponse?.items) ? activityResponse.items : []);
  };

  const handlePublicAction = async (actionType) => {
    if (!profile?.id) {
      return;
    }
    setSocialActionLoading(actionType);
    setStatusNote("");
    try {
      if (actionType === "add-friend") {
        await sendFriendRequest(profile.id);
        setStatusNote("Friend request sent.");
        await refreshPublicProfile();
      } else if (actionType === "cancel-request" && profile.relationship?.request_id) {
        await cancelFriendRequest(profile.relationship.request_id);
        setStatusNote("Friend request canceled.");
        await refreshPublicProfile();
      } else if (actionType === "accept-request" && profile.relationship?.request_id) {
        await acceptFriendRequest(profile.relationship.request_id);
        setStatusNote("Friend request accepted.");
        await refreshPublicProfile();
      } else if (actionType === "reject-request" && profile.relationship?.request_id) {
        await declineFriendRequest(profile.relationship.request_id);
        setStatusNote("Friend request rejected.");
        await refreshPublicProfile();
      } else if (actionType === "message") {
        const conversation = await createOrGetDirectConversation(profile.id);
        navigate("/social", { state: { conversationId: conversation.id } });
      } else if (actionType === "challenge") {
        const conversation = await createOrGetDirectConversation(profile.id);
        navigate("/social", {
          state: { conversationId: conversation.id, openChallengeComposer: true }
        });
      }
    } catch (actionError) {
      setStatusNote(actionError?.detail || actionError?.message || "Action failed.");
    } finally {
      setSocialActionLoading("");
    }
  };

  if (loading) {
    return (
      <main className="page-shell profile-page">
        <section className="profile-shell">
          <div className="loading-text">Loading player profile...</div>
        </section>
      </main>
    );
  }

  if (error || !profile) {
    return (
      <main className="page-shell profile-page">
        <section className="profile-shell">
          <header className="profile-header">
            <div>
              <div className="brand-mark">English Lemon</div>
              <h1>Player Profile</h1>
            </div>
            <button
              type="button"
              className="secondary-btn profile-nav-btn"
              onClick={() => navigate("/dashboard")}
            >
              Back to Dashboard
            </button>
          </header>

          <article className="feature-card profile-motivation-card">
            <p className="profile-motivation-label">Profile Unavailable</p>
            <p className="profile-motivation-message">{error || "Unable to load profile."}</p>
            <p className="profile-motivation-subtle">
              Try again in a moment. The rest of the app is still available.
            </p>
          </article>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell profile-page">
      <section className="profile-shell">
        <header className="profile-header">
          <div>
            <div className="brand-mark">English Lemon</div>
            <h1>{viewingOwnProfile ? "Player Profile" : `${profile.display_name}'s Profile`}</h1>
            <p className="dashboard-subtitle">
              {viewingOwnProfile
                ? "Your identity, progression, achievements, and performance in one premium player dashboard."
                : "Public player identity, visible progression, and live competitive presence."}
            </p>
          </div>
          <div className="profile-header-actions">
            {viewingOwnProfile ? <NotificationBell compact /> : null}
            <button
              type="button"
              className="secondary-btn profile-nav-btn"
              onClick={() => navigate("/dashboard")}
            >
              Back to Dashboard
            </button>
          </div>
        </header>

        {saveFeedback ? (
          <p className="profile-save-feedback" aria-live="polite">
            {saveFeedback}
          </p>
        ) : null}
        {statusNote ? <p className="profile-save-feedback is-warning">{statusNote}</p> : null}

        <section className="profile-hero-grid">
          <article className="feature-card profile-hero-card">
            <div className="profile-avatar-wrap">
              <div className={`profile-avatar ${profile.avatar_url ? "has-image" : ""}`}>
                {profile.avatar_url ? (
                  <img src={profile.avatar_url} alt={`${profile.display_name} avatar`} />
                ) : (
                  initials
                )}
              </div>
              <span className="profile-level-pill">Level {stats.level}</span>
              <span className="profile-level-pill">{tier.label}</span>
            </div>

            <div className="profile-hero-copy">
              <p className="profile-name">{profile.display_name}</p>
              <p className="profile-email">
                {viewingOwnProfile ? profile.email : `@${profile.username}`}
              </p>
              <div className="profile-meta-row">
                <span>Joined {formatDate(profile.joined_at)}</span>
                {recentActivity[0]?.created_at ? (
                  <span>Last active {formatRelativeTime(recentActivity[0].created_at)}</span>
                ) : null}
                {stats.rank ? <span>Rank #{stats.rank}</span> : <span>Rank pending</span>}
                {profile.relationship?.relationship_status && !viewingOwnProfile ? (
                  <span>{profile.relationship.relationship_status.replaceAll("_", " ")}</span>
                ) : null}
              </div>
              <p className="profile-bio">
                {profile.bio ||
                  "Focused on steady growth, sharper answers, and keeping competitive momentum alive."}
              </p>
            </div>

            <div className="profile-hero-highlights">
              <article>
                <span>Lemons</span>
                <strong>{formatNumber(stats.lemons_balance)}</strong>
              </article>
              <article>
                <span>Current Streak</span>
                <strong>{formatNumber(stats.streak)}x</strong>
              </article>
              <article>
                <span>Total Points</span>
                <strong>{formatNumber(stats.total_points)}</strong>
              </article>
              <article>
                <span>Achievements</span>
                <strong>
                  {formatNumber(unlockedAchievements)} / {formatNumber(stats.achievements.length)}
                </strong>
              </article>
            </div>

            <div className="profile-identity-actions">
              {viewingOwnProfile ? (
                <>
                  <button
                    type="button"
                    className="secondary-btn profile-edit-btn"
                    onClick={handleOpenEdit}
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
                </>
              ) : (
                <>
                  {profile.relationship?.relationship_status === "none" ? (
                    <button
                      type="button"
                      className="secondary-btn profile-edit-btn"
                      onClick={() => void handlePublicAction("add-friend")}
                      disabled={socialActionLoading === "add-friend"}
                    >
                      {socialActionLoading === "add-friend" ? "Sending..." : "Add Friend"}
                    </button>
                  ) : null}
                  {profile.relationship?.relationship_status === "outgoing_request" ? (
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => void handlePublicAction("cancel-request")}
                      disabled={socialActionLoading === "cancel-request"}
                    >
                      Cancel Request
                    </button>
                  ) : null}
                  {profile.relationship?.relationship_status === "incoming_request" ? (
                    <>
                      <button
                        type="button"
                        className="secondary-btn profile-edit-btn"
                        onClick={() => void handlePublicAction("accept-request")}
                        disabled={socialActionLoading === "accept-request"}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => void handlePublicAction("reject-request")}
                        disabled={socialActionLoading === "reject-request"}
                      >
                        Reject
                      </button>
                    </>
                  ) : null}
                  {profile.relationship?.can_message ? (
                    <>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => void handlePublicAction("message")}
                        disabled={socialActionLoading === "message"}
                      >
                        Message
                      </button>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => void handlePublicAction("challenge")}
                        disabled={socialActionLoading === "challenge"}
                      >
                        Challenge
                      </button>
                    </>
                  ) : null}
                </>
              )}
              <span className="profile-edit-hint">{tier.message}</span>
            </div>
          </article>

          <article className="feature-card profile-motivation-card">
            <p className="profile-motivation-label">Competitive Pulse</p>
            <p className="profile-motivation-message">{motivation.headline}</p>
            <p className="profile-motivation-subtle">{motivation.message}</p>
            <div className="profile-motivation-pills">
              <span>{formatPercent(stats.accuracy_percentage)} Accuracy</span>
              <span>{formatNumber(stats.quizzes_played)} Quizzes</span>
              <span>{formatNumber(stats.quizzes_won)} Wins</span>
              <span>{formatNumber(stats.categories_explored)} Categories</span>
            </div>
          </article>
        </section>

        <section className="profile-stats-grid">
          <article className="feature-card profile-stat-card is-lemons">
            <span>Lemons Balance</span>
            <strong>{formatNumber(stats.lemons_balance)}</strong>
          </article>
          <article className="feature-card profile-stat-card">
            <span>Total Points</span>
            <strong>{formatNumber(stats.total_points)}</strong>
          </article>
          <article className="feature-card profile-stat-card">
            <span>Quizzes Played</span>
            <strong>{formatNumber(stats.quizzes_played)}</strong>
          </article>
          <article className="feature-card profile-stat-card">
            <span>Quizzes Won</span>
            <strong>{formatNumber(stats.quizzes_won)}</strong>
          </article>
          <article className="feature-card profile-stat-card">
            <span>Correct Answers</span>
            <strong>{formatNumber(stats.correct_answers)}</strong>
          </article>
          <article className="feature-card profile-stat-card">
            <span>Accuracy</span>
            <strong>{formatPercent(stats.accuracy_percentage)}</strong>
          </article>
          <article className="feature-card profile-stat-card">
            <span>Best Streak</span>
            <strong>{formatNumber(stats.best_streak)}x</strong>
          </article>
          <article className="feature-card profile-stat-card">
            <span>Rank</span>
            <strong>{stats.rank ? `#${stats.rank}` : "--"}</strong>
          </article>
          <article className="feature-card profile-stat-card">
            <span>Favorite Category</span>
            <strong className="profile-category-badge">{stats.favorite_category || "Mixed"}</strong>
          </article>
        </section>

        <section className="profile-progress-grid">
          <article className="feature-card profile-progress-card">
            <p className="profile-progress-title">XP Progress</p>
            <div className="profile-progress-headline">
              <strong>Level {stats.level}</strong>
              <span>
                {formatNumber(stats.xp_into_level)} / {formatNumber(stats.xp_for_next_level)} XP
              </span>
            </div>
            <div className="profile-progress-track" role="progressbar" aria-valuenow={progress.xpProgress} aria-valuemin={0} aria-valuemax={100}>
              <div className="profile-progress-fill" style={{ width: `${progress.xpProgress}%` }} />
            </div>
            <p className="profile-progress-footnote">
              {formatNumber(Math.max(0, stats.xp_for_next_level - stats.xp_into_level))} XP to next level
            </p>
          </article>

          <article className="feature-card profile-progress-card">
            <p className="profile-progress-title">Streak Milestone</p>
            <div className="profile-progress-headline">
              <strong>{formatNumber(stats.streak)}x current</strong>
              <span>{formatNumber(progress.nextStreakTarget)}x next target</span>
            </div>
            <div className="profile-progress-track" role="progressbar" aria-valuenow={progress.streakProgress} aria-valuemin={0} aria-valuemax={100}>
              <div className="profile-progress-fill is-cool" style={{ width: `${progress.streakProgress}%` }} />
            </div>
            <p className="profile-progress-footnote">Stay active to convert consistency into milestone momentum.</p>
          </article>

          <article className="feature-card profile-progress-card">
            <p className="profile-progress-title">Achievement Progress</p>
            <div className="profile-progress-headline">
              <strong>
                {formatNumber(unlockedAchievements)} / {formatNumber(stats.achievements.length)} unlocked
              </strong>
              <span>{formatPercent(progress.achievementCompletion)}</span>
            </div>
            <div className="profile-progress-track" role="progressbar" aria-valuenow={progress.achievementCompletion} aria-valuemin={0} aria-valuemax={100}>
              <div className="profile-progress-fill" style={{ width: `${progress.achievementCompletion}%` }} />
            </div>
            <p className="profile-progress-footnote">
              {nextAchievement
                ? `Next: ${nextAchievement.label} (${formatNumber(nextAchievement.current)} / ${formatNumber(nextAchievement.target)})`
                : "All current milestones unlocked."}
            </p>
          </article>

          <article className="feature-card profile-progress-card">
            <p className="profile-progress-title">Season Position</p>
            <div className="profile-progress-headline">
              <strong>{stats.rank ? `Rank #${stats.rank}` : "Unranked"}</strong>
              <span>{formatNumber(stats.total_points)} total points</span>
            </div>
            <div className="profile-progress-track" role="progressbar" aria-valuenow={progress.xpProgress} aria-valuemin={0} aria-valuemax={100}>
              <div className="profile-progress-fill is-cool" style={{ width: `${Math.min(100, Math.max(12, progress.xpProgress))}%` }} />
            </div>
            <p className="profile-progress-footnote">
              Rankings strengthen as more players sync competitive progress into the season board.
            </p>
          </article>
        </section>

        <section className="profile-bottom-grid">
          <article className="feature-card profile-activity-card">
            <p className="profile-section-title">Recent Activity</p>
            <p className="profile-empty-copy">
              Live player history, latest first.
            </p>
            {recentActivity.length ? (
              <ul className="profile-activity-list">
                {recentActivity.slice(0, 6).map((item, index) => (
                  <li key={`${item.type}-${item.created_at}-${index}`}>
                    <div>
                      <strong>{item.title}</strong>
                      <span>{formatDate(item.created_at, { withTime: true })}</span>
                    </div>
                    <div className="profile-activity-metrics">
                      <span>{item.type.replaceAll("_", " ")}</span>
                      {item.subtitle ? <span>{item.subtitle}</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="profile-empty-copy">
                No recent activity yet. Complete a quiz or social action to populate this timeline.
              </p>
            )}
          </article>

          <article className="feature-card profile-achievements-card">
            <p className="profile-section-title">Milestones</p>
            <p className="profile-empty-copy">
              Unlock badges to make your player identity feel earned, not just configured.
            </p>
            <ul className="profile-achievements-list">
              {stats.achievements.map((achievement) => (
                <li
                  key={achievement.id}
                  className={achievement.unlocked ? "is-unlocked" : "is-locked"}
                >
                  <span>
                    {achievement.label}
                    {!achievement.unlocked
                      ? ` (${formatNumber(achievement.current)} / ${formatNumber(achievement.target)})`
                      : ""}
                  </span>
                  <strong>{achievement.unlocked ? "Unlocked" : "In Progress"}</strong>
                </li>
              ))}
            </ul>
          </article>
        </section>
      </section>

      {viewingOwnProfile ? (
        <div
          className={`profile-edit-overlay ${isEditOpen ? "is-open" : ""}`}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              handleCloseEdit();
            }
          }}
          aria-hidden={!isEditOpen}
        >
          <section className="profile-edit-panel" aria-modal="true" role="dialog">
            <header className="profile-edit-header">
              <h2>Edit Profile</h2>
              <p>Update your public player identity for English Lemon.</p>
              <p className="profile-motivation-subtle">
                {hasChanges ? "You have unsaved changes." : "Everything is currently saved."}
              </p>
            </header>

            <form className="profile-edit-form" onSubmit={handleSaveProfile}>
              <div className="profile-edit-avatar-row">
                <div className={`profile-avatar profile-avatar-edit ${formValues.avatar_url ? "has-image" : ""}`}>
                  {formValues.avatar_url ? (
                    <img src={formValues.avatar_url} alt="Avatar preview" />
                  ) : (
                    getInitials(formValues.display_name, formValues.username, formValues.email)
                  )}
                </div>
                <div className="profile-edit-avatar-actions">
                  <label className="profile-field">
                    <span>Avatar URL</span>
                    <input
                      type="url"
                      value={formValues.avatar_url}
                      onChange={(event) =>
                        setFormValues((previous) => ({
                          ...previous,
                          avatar_url: event.target.value
                        }))
                      }
                      placeholder="https://..."
                    />
                  </label>
                </div>
              </div>

              <div className="profile-edit-grid">
                <label className="profile-field">
                  <span>Display Name</span>
                  <input
                    type="text"
                    value={formValues.display_name}
                    onChange={(event) =>
                      setFormValues((previous) => ({
                        ...previous,
                        display_name: event.target.value
                      }))
                    }
                    placeholder="Your display name"
                    required
                  />
                  {formErrors.display_name ? (
                    <p className="profile-field-error">{formErrors.display_name}</p>
                  ) : null}
                </label>

                <label className="profile-field">
                  <span>Username</span>
                  <input
                    type="text"
                    value={formValues.username}
                    onChange={(event) =>
                      setFormValues((previous) => ({
                        ...previous,
                        username: event.target.value
                      }))
                    }
                    placeholder="username"
                    required
                  />
                  {formErrors.username ? (
                    <p className="profile-field-error">{formErrors.username}</p>
                  ) : null}
                </label>
              </div>

              <label className="profile-field">
                <span>Email</span>
                <input type="email" value={formValues.email} disabled />
                <div className="profile-field-footnote">
                  <span>Email stays private and comes from your account login.</span>
                </div>
              </label>

              <label className="profile-field">
                <span>Bio</span>
                <textarea
                  value={formValues.bio}
                  onChange={(event) =>
                    setFormValues((previous) => ({
                      ...previous,
                      bio: event.target.value
                    }))
                  }
                  placeholder="Share your current focus, streak target, or category grind."
                  maxLength={MAX_BIO_LENGTH}
                  rows={3}
                />
                <div className="profile-field-footnote">
                  <span>
                    {formatNumber(formValues.bio.length)} / {formatNumber(MAX_BIO_LENGTH)}
                  </span>
                </div>
                {formErrors.bio ? <p className="profile-field-error">{formErrors.bio}</p> : null}
              </label>

              {formErrors.form ? <p className="profile-field-error">{formErrors.form}</p> : null}

              <footer className="profile-edit-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={handleCloseEdit}
                  disabled={isSaving}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary-btn profile-save-btn"
                  disabled={isSaving || !hasChanges || Object.keys(validationErrors).length > 0}
                >
                  {isSaving ? "Saving..." : "Save Changes"}
                </button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default ProfilePage;
