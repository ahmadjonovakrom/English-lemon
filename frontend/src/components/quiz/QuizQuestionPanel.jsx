import { useEffect, useRef, useState } from "react";

function QuizQuestionPanel({
  question,
  questionNumber,
  totalQuestions,
  selectedIndex,
  isLocked,
  onSelectOption,
  feedbackState,
  feedbackMessage,
  progressPercent,
  sessionLemons,
  currentStreak
}) {
  const safeQuestion =
    question &&
    typeof question.question === "string" &&
    Array.isArray(question.options) &&
    question.options.length === 4
      ? question
      : {
          id: "quiz-safe-fallback",
          question: "Choose the correct sentence:",
          options: [
            "She don't likes coffee.",
            "She doesn't like coffee.",
            "She not likes coffee.",
            "She doesn't likes coffee."
          ],
          correctAnswer: 1,
          category: "Grammar",
          explanation: "With 'she', use 'doesn't' + base verb."
        };
  const safeQuestionNumber =
    Number.isInteger(questionNumber) && questionNumber > 0 ? questionNumber : 1;
  const safeTotalQuestions =
    Number.isInteger(totalQuestions) && totalQuestions > 0
      ? totalQuestions
      : safeQuestionNumber;
  const safeProgressPercent =
    typeof progressPercent === "number" && progressPercent >= 0
      ? Math.min(progressPercent, 100)
      : Math.round((safeQuestionNumber / safeTotalQuestions) * 100);
  const safeSessionLemons =
    Number.isFinite(sessionLemons) && sessionLemons >= 0 ? sessionLemons : 0;
  const safeStreak = Number.isFinite(currentStreak) && currentStreak >= 0 ? currentStreak : 0;
  const [isLemonsPulsing, setIsLemonsPulsing] = useState(false);
  const previousLemonsRef = useRef(safeSessionLemons);

  useEffect(() => {
    if (safeSessionLemons > previousLemonsRef.current) {
      setIsLemonsPulsing(true);
      const timerId = setTimeout(() => {
        setIsLemonsPulsing(false);
      }, 360);
      previousLemonsRef.current = safeSessionLemons;
      return () => clearTimeout(timerId);
    }

    previousLemonsRef.current = safeSessionLemons;
    return undefined;
  }, [safeSessionLemons]);

  const correctIndex =
    Number.isInteger(safeQuestion.correctAnswer) &&
    safeQuestion.correctAnswer >= 0 &&
    safeQuestion.correctAnswer < 4
      ? safeQuestion.correctAnswer
      : 0;
  const optionLabels = ["A", "B", "C", "D"];

  return (
    <section className="quiz-panel quiz-question-panel">
      <header className="quiz-question-header">
        <div className="quiz-progress-copy">
          <p className="quiz-counter">
            Question {safeQuestionNumber} of {safeTotalQuestions}
          </p>
          <div className="quiz-tags">
            <span>{safeQuestion.category ?? "Mixed"}</span>
          </div>
        </div>
        <div className="quiz-session-hud">
          <article className="quiz-hud-pill">
            <span>Lemons</span>
            <strong className={`quiz-lemons-value ${isLemonsPulsing ? "is-pulsing" : ""}`}>
              {"\u{1F34B}"} {safeSessionLemons}
            </strong>
          </article>
          <article className={`quiz-hud-pill ${safeStreak > 1 ? "is-hot" : ""}`}>
            <span>Streak</span>
            <strong>{safeStreak}x</strong>
          </article>
        </div>
        <div
          className="quiz-progress-track"
          role="progressbar"
          aria-valuenow={safeProgressPercent}
        >
          <div className="quiz-progress-fill" style={{ width: `${safeProgressPercent}%` }} />
        </div>
      </header>

      <h2 className="quiz-question-text">{safeQuestion.question}</h2>

      <div className="quiz-options-grid">
        {safeQuestion.options.map((option, index) => {
          const isSelected = selectedIndex === index;
          const isCorrect = isLocked && index === correctIndex;
          const isIncorrect = isLocked && isSelected && index !== correctIndex;

          return (
            <button
              key={`${safeQuestion.id}-${optionLabels[index]}-${option}`}
              type="button"
              className={`quiz-option-btn${isSelected ? " is-selected" : ""}${
                isCorrect ? " is-correct" : ""
              }${isIncorrect ? " is-incorrect" : ""}${isLocked ? " is-revealed" : ""}`}
              onClick={() => onSelectOption(index)}
              aria-pressed={isSelected}
              aria-disabled={isLocked}
              disabled={isLocked}
            >
              <div className="quiz-option-head">
                <span className="quiz-option-index">{optionLabels[index]}</span>
                {isCorrect ? <span className="quiz-option-status">Correct</span> : null}
                {isIncorrect ? <span className="quiz-option-status">Your Pick</span> : null}
              </div>
              <span className="quiz-option-label">{option}</span>
            </button>
          );
        })}
      </div>

      {isLocked ? (
        <div className={`quiz-feedback-box ${feedbackState}`}>
          <p className="quiz-feedback-title">{feedbackMessage}</p>
          {safeQuestion.explanation ? (
            <p className="quiz-feedback-copy">{safeQuestion.explanation}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default QuizQuestionPanel;
