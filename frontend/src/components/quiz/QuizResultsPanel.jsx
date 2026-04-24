import { useEffect, useMemo, useState } from "react";
import { DEFAULT_QUIZ_CATEGORY } from "../../features/quiz/constants";

function QuizResultsPanel({
  results,
  totalQuestions,
  category,
  onPlayAgain,
  onBackToDashboard
}) {
  const safeResults = {
    totalCorrect: Number.isFinite(results?.totalCorrect) ? results.totalCorrect : 0,
    totalWrong: Number.isFinite(results?.totalWrong) ? results.totalWrong : 0,
    accuracy: Number.isFinite(results?.accuracy) ? results.accuracy : 0,
    lemonsEarned: Number.isFinite(results?.lemonsEarned) ? results.lemonsEarned : 0,
    bestStreak: Number.isFinite(results?.bestStreak) ? results.bestStreak : 0,
    summaryMessage:
      typeof results?.summaryMessage === "string" && results.summaryMessage.trim()
        ? results.summaryMessage
        : "Round complete."
  };
  const safeTotalQuestions =
    Number.isInteger(totalQuestions) && totalQuestions > 0 ? totalQuestions : safeResults.totalCorrect;
  const safeCategory =
    typeof category === "string" && category.trim() ? category : DEFAULT_QUIZ_CATEGORY;
  const [isVisible, setIsVisible] = useState(false);
  const [animatedLemons, setAnimatedLemons] = useState(0);
  const [isRewardActive, setIsRewardActive] = useState(true);

  const encouragement = useMemo(() => {
    if (safeResults.accuracy >= 90) {
      return "Excellent work";
    }
    if (safeResults.accuracy >= 75) {
      return "Great job";
    }
    if (safeResults.accuracy >= 55) {
      return "Nice effort";
    }
    return "Keep practicing";
  }, [safeResults.accuracy]);

  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      setIsVisible(true);
    });
    return () => cancelAnimationFrame(frameId);
  }, []);

  useEffect(() => {
    let rafId = 0;
    let glowTimeoutId = 0;
    const durationMs = 980;
    const target = Math.max(0, safeResults.lemonsEarned);
    const start = performance.now();

    setAnimatedLemons(0);
    setIsRewardActive(true);

    const tick = (now) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / durationMs, 1);
      const eased = 1 - (1 - progress) ** 3;
      setAnimatedLemons(Math.round(target * eased));

      if (progress < 1) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      glowTimeoutId = window.setTimeout(() => {
        setIsRewardActive(false);
      }, 420);
    };

    rafId = requestAnimationFrame(tick);

    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      if (glowTimeoutId) {
        clearTimeout(glowTimeoutId);
      }
    };
  }, [safeResults.lemonsEarned]);

  return (
    <section className={`quiz-panel quiz-results-panel ${isVisible ? "is-visible" : ""}`}>
      <div className="brand-mark">English Lemon</div>
      <h1>Quiz Complete</h1>
      <p className="quiz-results-kicker">{encouragement}</p>
      <p className="quiz-panel-subtitle">{safeResults.summaryMessage}</p>

      <div className="quiz-result-meta">
        <span>{safeCategory} Mode</span>
        {safeResults.bestStreak > 0 ? <span>Best Streak: {safeResults.bestStreak}x</span> : null}
      </div>

      <div className={`quiz-lemons-earned ${isRewardActive ? "is-reward-active" : ""}`}>
        <span>Lemons Earned</span>
        <strong className={`quiz-results-lemons ${isRewardActive ? "is-counting" : ""}`}>
          🍋 {animatedLemons}
        </strong>
      </div>

      <div className="quiz-results-grid">
        <article>
          <span>Correct</span>
          <strong>
            {safeResults.totalCorrect} / {safeTotalQuestions}
          </strong>
        </article>
        <article>
          <span>Wrong</span>
          <strong>{safeResults.totalWrong}</strong>
        </article>
        <article>
          <span>Accuracy</span>
          <strong>{safeResults.accuracy}%</strong>
        </article>
        <article>
          <span>Best Streak</span>
          <strong>{safeResults.bestStreak}x</strong>
        </article>
      </div>

      <div className="quiz-results-actions">
        <button type="button" className="primary-btn quiz-results-primary-btn" onClick={onPlayAgain}>
          Play Again
        </button>
        <button
          type="button"
          className="secondary-btn quiz-results-secondary-btn"
          onClick={onBackToDashboard}
        >
          Back to Dashboard
        </button>
      </div>
    </section>
  );
}

export default QuizResultsPanel;
