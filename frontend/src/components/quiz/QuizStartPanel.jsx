function QuizStartPanel({
  categories,
  selectedCategory,
  onSelectCategory,
  availableCount,
  totalQuestions,
  onStart,
  errorMessage = ""
}) {
  const safeCategories = Array.isArray(categories) && categories.length ? categories : ["Mixed"];

  return (
    <section className="quiz-panel quiz-start-panel">
      <div className="brand-mark">English Lemon</div>
      <h1>Quiz Arena</h1>
      <p className="quiz-panel-subtitle">
        Pick a category and jump into fast rounds with instant feedback and lemon
        rewards.
      </p>

      {errorMessage ? <p className="quiz-inline-error">{errorMessage}</p> : null}

      <div className="quiz-category-block">
        <p className="quiz-section-title">Category</p>
        <div className="quiz-category-grid">
          {safeCategories.map((category) => (
            <button
              key={category}
              type="button"
              className={`quiz-category-chip ${
                selectedCategory === category ? "is-active" : ""
              }`}
              onClick={() => onSelectCategory(category)}
              aria-pressed={selectedCategory === category}
            >
              {category}
            </button>
          ))}
        </div>
      </div>

      <div className="quiz-start-stats">
        <div>
          <span>Round Size</span>
          <strong>{totalQuestions}</strong>
        </div>
        <div>
          <span>Available</span>
          <strong>{availableCount}</strong>
        </div>
        <div>
          <span>Flow</span>
          <strong>Auto Advance</strong>
        </div>
        <div>
          <span>Reward</span>
          <strong>🍋 Lemons</strong>
        </div>
      </div>

      <button
        type="button"
        className="primary-btn quiz-start-btn"
        onClick={onStart}
        disabled={!totalQuestions}
      >
        Start Quiz
      </button>
    </section>
  );
}

export default QuizStartPanel;
