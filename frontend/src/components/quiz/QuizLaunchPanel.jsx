function QuizLaunchPanel({ category, totalQuestions }) {
  return (
    <section className="quiz-panel quiz-launch-panel" aria-live="polite">
      <div className="quiz-launch-glow" aria-hidden="true" />
      <div className="brand-mark">English Lemon</div>
      <h1>Get Ready</h1>
      <p className="quiz-panel-subtitle">
        {category} round is loading with {totalQuestions} questions.
      </p>
      <div className="quiz-launch-loader" aria-hidden="true" />
    </section>
  );
}

export default QuizLaunchPanel;
