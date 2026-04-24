import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { readQuizProfileStats } from "../features/quiz/utils/quizProfileStats";
import "../features/leaderboard/leaderboard.css";

const LEADERBOARD_PERIODS = [
  { id: "all-time", label: "All Time", isAvailable: true },
  { id: "daily", label: "Daily", isAvailable: false },
  { id: "weekly", label: "Weekly", isAvailable: false }
];

const SEED_LEADERBOARD_PLAYERS = [
  { id: "seed-1", username: "LexiPrime", totalLemons: 1690, quizzesPlayed: 238, accuracy: 92 },
  { id: "seed-2", username: "WordFalcon", totalLemons: 1455, quizzesPlayed: 211, accuracy: 89 },
  { id: "seed-3", username: "NorthFluent", totalLemons: 1310, quizzesPlayed: 194, accuracy: 87 },
  { id: "seed-4", username: "MinaScope", totalLemons: 1195, quizzesPlayed: 173, accuracy: 85 },
  { id: "seed-5", username: "CrispSyntax", totalLemons: 1110, quizzesPlayed: 161, accuracy: 84 },
  { id: "seed-6", username: "EchoReader", totalLemons: 995, quizzesPlayed: 149, accuracy: 82 },
  { id: "seed-7", username: "IvyPronounce", totalLemons: 910, quizzesPlayed: 132, accuracy: 80 },
  { id: "seed-8", username: "DeltaLingua", totalLemons: 865, quizzesPlayed: 126, accuracy: 79 },
  { id: "seed-9", username: "NovaIdiom", totalLemons: 790, quizzesPlayed: 113, accuracy: 77 },
  { id: "seed-10", username: "SlateCollocate", totalLemons: 715, quizzesPlayed: 98, accuracy: 75 }
];

const numberFormatter = new Intl.NumberFormat("en-US");

function toSafeNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function formatNumber(value) {
  return numberFormatter.format(Math.max(0, Math.floor(toSafeNumber(value))));
}

function formatPercent(value) {
  return `${Math.max(0, Math.min(100, Math.round(toSafeNumber(value))))}%`;
}

function buildCurrentUserEntry(user) {
  if (!user) {
    return null;
  }

  const stats = readQuizProfileStats();
  const totalQuestions = toSafeNumber(stats.totalQuestionsAnswered);
  const accuracy = totalQuestions
    ? Math.round((toSafeNumber(stats.totalCorrectAnswers) / totalQuestions) * 100)
    : 0;

  return {
    id: `user-${user.id ?? user.email ?? user.username ?? "current"}`,
    username:
      typeof user.username === "string" && user.username.trim() ? user.username.trim() : "You",
    totalLemons: Math.max(0, Math.floor(toSafeNumber(stats.totalLemons))),
    quizzesPlayed: Math.max(0, Math.floor(toSafeNumber(stats.quizzesPlayed))),
    accuracy: Math.max(0, Math.min(100, accuracy)),
    isCurrentUser: true
  };
}

function buildAllTimeRows(currentUserEntry) {
  const rows = [...SEED_LEADERBOARD_PLAYERS];

  if (currentUserEntry) {
    const duplicateIndex = rows.findIndex(
      (entry) => entry.username.toLowerCase() === currentUserEntry.username.toLowerCase()
    );

    if (duplicateIndex >= 0) {
      rows[duplicateIndex] = {
        ...rows[duplicateIndex],
        ...currentUserEntry,
        isCurrentUser: true
      };
    } else {
      rows.push(currentUserEntry);
    }
  }

  return rows
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
}

function getRankMessage(rank, playerCount) {
  if (!rank) {
    return "Play a quiz round to enter the current season race.";
  }

  const safeCount = Math.max(playerCount, 1);
  const percentile = Math.max(1, Math.round(((safeCount - rank + 1) / safeCount) * 100));

  if (rank <= 3) {
    return `Elite pace. You're in the top 3 and ahead of ${percentile}% of players.`;
  }
  if (rank <= 10) {
    return "You're in the top 10. One strong run can move you to podium range.";
  }
  return `You're currently #${rank}, ahead of ${percentile}% of this season's field.`;
}

function getPerformanceMessage(accuracy, rank) {
  if (rank && rank <= 3) {
    return "Dominant consistency. Keep pressure on the top spot.";
  }
  if (accuracy >= 90) {
    return "Excellent accuracy. Convert this precision into more lemons.";
  }
  if (accuracy >= 80) {
    return "Strong pace. A few more clean rounds will move your rank quickly.";
  }
  if (accuracy >= 65) {
    return "Solid base. Tighten answers and your climb will accelerate.";
  }
  return "You're building momentum. Keep stacking rounds before the season reset.";
}

function buildPodiumRows(rows) {
  const topThree = rows.slice(0, 3);
  const first = topThree.find((entry) => entry.rank === 1);
  const second = topThree.find((entry) => entry.rank === 2);
  const third = topThree.find((entry) => entry.rank === 3);
  return [second, first, third].filter(Boolean);
}

function getRankTitle(rank) {
  if (rank === 1) {
    return "Season Leader";
  }
  if (rank === 2) {
    return "Lead Challenger";
  }
  if (rank === 3) {
    return "Top Contender";
  }
  return "Competitor";
}

function LeaderboardPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [activePeriod, setActivePeriod] = useState("all-time");
  const [isLoadingBoard, setIsLoadingBoard] = useState(true);

  const currentUserEntry = useMemo(() => buildCurrentUserEntry(user), [user]);
  const allTimeRows = useMemo(() => buildAllTimeRows(currentUserEntry), [currentUserEntry]);
  const isAllTime = activePeriod === "all-time";
  const displayedRows = isAllTime ? allTimeRows : [];
  const currentUserRow = displayedRows.find((entry) => entry.isCurrentUser) ?? null;
  const currentUserRank = currentUserRow?.rank ?? null;
  const playerStatsSource = currentUserRow ?? currentUserEntry;
  const podiumRows = useMemo(() => buildPodiumRows(displayedRows), [displayedRows]);
  const activePeriodLabel =
    LEADERBOARD_PERIODS.find((period) => period.id === activePeriod)?.label ?? "Leaderboard";

  useEffect(() => {
    setIsLoadingBoard(true);
    const timer = window.setTimeout(() => {
      setIsLoadingBoard(false);
    }, 260);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activePeriod]);

  const rankMessage = getRankMessage(currentUserRank, displayedRows.length);
  const performanceMessage = getPerformanceMessage(
    playerStatsSource?.accuracy ?? 0,
    currentUserRank
  );

  return (
    <main className="page-shell lb-page">
      <section className="lb-shell">
        <header className="feature-card lb-hero">
          <div className="lb-hero-copy">
            <div className="brand-mark">English Lemon</div>
            <div className="lb-hero-title-row">
              <h1>Leaderboard</h1>
              <span className="lb-hero-season-chip">Current Season</span>
            </div>
            <p className="lb-hero-subtitle">
              Push your rank, defend your position, and climb while this season is live.
            </p>
            <p className="lb-hero-helper">
              The <strong>All Time</strong> board shows cumulative results for the current season.
              Rankings reset at the start of every new season.
            </p>
          </div>
          <button
            type="button"
            className="secondary-btn lb-back-btn"
            onClick={() => navigate("/dashboard")}
          >
            Back to Dashboard
          </button>
        </header>

        <section className="feature-card lb-tabs-card">
          <div className="lb-tabs" role="tablist" aria-label="Leaderboard periods">
            {LEADERBOARD_PERIODS.map((period) => (
              <button
                key={period.id}
                type="button"
                role="tab"
                aria-selected={activePeriod === period.id}
                aria-label={
                  period.isAvailable
                    ? `${period.label} leaderboard`
                    : `${period.label} leaderboard coming soon`
                }
                className={`lb-tab-btn ${activePeriod === period.id ? "is-active" : ""}`}
                onClick={() => setActivePeriod(period.id)}
              >
                <span>{period.label}</span>
                {!period.isAvailable ? <em>Soon</em> : null}
              </button>
            ))}
          </div>
          <p className="lb-tab-note">
            {isAllTime
              ? "All Time tracks this season's full standings and refreshes when the next season begins."
              : `${activePeriodLabel} standings are coming soon. Keep collecting lemons in All Time to stay ready.`}
          </p>
        </section>

        <section className="feature-card lb-position-card">
          <div className="lb-position-head">
            <span className="lb-section-kicker">Your Competitive Position</span>
            <p>{rankMessage}</p>
          </div>
          <div className="lb-position-grid">
            <article className="lb-position-metric">
              <span>Your Rank</span>
              <strong>{currentUserRank ? `#${currentUserRank}` : "Unranked"}</strong>
            </article>
            <article className="lb-position-metric is-lemons">
              <span>Total Lemons</span>
              <strong>🍋 {formatNumber(playerStatsSource?.totalLemons)}</strong>
            </article>
            <article className="lb-position-metric">
              <span>Accuracy</span>
              <strong>{formatPercent(playerStatsSource?.accuracy)}</strong>
            </article>
            <article className="lb-position-metric">
              <span>Quizzes Played</span>
              <strong>{formatNumber(playerStatsSource?.quizzesPlayed)}</strong>
            </article>
          </div>
          <p className="lb-position-footnote">{performanceMessage}</p>
        </section>

        {isLoadingBoard ? (
          <section className="feature-card lb-state-card" role="status" aria-live="polite">
            <div className="lb-loading-spinner" aria-hidden="true" />
            <h2>Loading leaderboard...</h2>
            <p className="subtle-text">Syncing current season standings.</p>
          </section>
        ) : isAllTime ? (
          <>
            {podiumRows.length ? (
              <section className="lb-podium-grid">
                {podiumRows.map((player) => (
                  <article
                    key={player.id}
                    className={`feature-card lb-podium-card rank-${player.rank} ${
                      player.isCurrentUser ? "is-current-user" : ""
                    }`}
                  >
                    <div className="lb-podium-head">
                      <span className="lb-podium-rank">#{player.rank}</span>
                      <span className="lb-podium-title">{getRankTitle(player.rank)}</span>
                    </div>
                    <p className="lb-podium-name">
                      {player.username}
                      {player.isCurrentUser ? <span>You</span> : null}
                    </p>
                    <div className="lb-podium-metrics">
                      <article>
                        <span>Lemons</span>
                        <strong>🍋 {formatNumber(player.totalLemons)}</strong>
                      </article>
                      <article>
                        <span>Accuracy</span>
                        <strong>{formatPercent(player.accuracy)}</strong>
                      </article>
                      <article>
                        <span>Quizzes</span>
                        <strong>{formatNumber(player.quizzesPlayed)}</strong>
                      </article>
                    </div>
                  </article>
                ))}
              </section>
            ) : null}

            {displayedRows.length ? (
              <section className="feature-card lb-list-card">
                <div className="lb-list-head" aria-hidden="true">
                  <span>Rank</span>
                  <span>Player</span>
                  <span>Lemons</span>
                  <span>Quizzes</span>
                  <span>Accuracy</span>
                </div>
                <div className="lb-list-body">
                  {displayedRows.map((row) => (
                    <article
                      key={row.id}
                      className={`lb-row ${row.isCurrentUser ? "is-current-user" : ""} ${
                        row.rank <= 3 ? "is-elite" : ""
                      }`}
                    >
                      <span className="lb-cell lb-cell-rank" data-label="Rank">
                        <strong>#{row.rank}</strong>
                        {row.rank <= 3 ? <em>Elite</em> : null}
                      </span>
                      <span className="lb-cell lb-cell-player" data-label="Player">
                        {row.username}
                        {row.isCurrentUser ? <i>You</i> : null}
                      </span>
                      <span className="lb-cell lb-cell-lemons" data-label="Lemons">
                        🍋 {formatNumber(row.totalLemons)}
                      </span>
                      <span className="lb-cell" data-label="Quizzes">
                        {formatNumber(row.quizzesPlayed)}
                      </span>
                      <span className="lb-cell" data-label="Accuracy">
                        {formatPercent(row.accuracy)}
                      </span>
                    </article>
                  ))}
                </div>
              </section>
            ) : (
              <section className="feature-card lb-state-card">
                <h2>No standings yet</h2>
                <p className="subtle-text">
                  No players are ranked yet for this season. Complete a quiz round and claim the
                  first spot.
                </p>
              </section>
            )}
          </>
        ) : (
          <section className="feature-card lb-state-card">
            <h2>{activePeriodLabel} board coming soon</h2>
            <p className="subtle-text">
              All Time is live for the current season standings. Daily and Weekly boards will open
              in a future update.
            </p>
          </section>
        )}
      </section>
    </main>
  );
}

export default LeaderboardPage;
