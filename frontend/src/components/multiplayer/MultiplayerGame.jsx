import LiveLeaderboard from "./LiveLeaderboard";

function formatTimer(seconds) {
  const safeSeconds = Math.max(0, seconds);
  return `00:${String(safeSeconds).padStart(2, "0")}`;
}

function MultiplayerGame({
  room,
  players,
  currentUserId,
  connectionState,
  submittingAnswer,
  statusMessage,
  onSubmitAnswer
}) {
  const currentQuestion = room.game.current_question;
  const leaderboard = room.game.leaderboard;
  const reveal = room.game.last_reveal;
  const currentPlayer = players.find((player) => player.user_id === currentUserId);
  const revealMap = new Map(
    (reveal?.player_results || []).map((entry) => [entry.user_id, entry])
  );

  if (!currentQuestion) {
    return (
      <section className="multiplayer-room-view">
        <article className="multiplayer-panel multiplayer-waiting-panel">
          <p className="brand-mark">Multiplayer Match</p>
          <h1>Waiting for the next question</h1>
          <p className="subtle-text">
            {room.room.status === "starting"
              ? "The host triggered the match. Countdown is running."
              : "A reveal is on screen or the server is advancing the match."}
          </p>
          {statusMessage ? <p className="multiplayer-status-note">{statusMessage}</p> : null}
        </article>
      </section>
    );
  }

  return (
    <section className="multiplayer-room-view">
      <div className="multiplayer-room-main">
        <article className="multiplayer-panel multiplayer-question-panel">
          <div className="multiplayer-question-top">
            <div>
              <p className="brand-mark">Question {currentQuestion.question_number}</p>
              <h1>{currentQuestion.question_text}</h1>
            </div>
            <div className="multiplayer-question-timer">
              <span>Time</span>
              <strong>{formatTimer(currentQuestion.remaining_seconds)}</strong>
            </div>
          </div>

          <div className="multiplayer-room-meta">
            <span>{currentQuestion.category}</span>
            <span>{currentQuestion.difficulty}</span>
            <span>
              {currentQuestion.question_number}/{currentQuestion.total_questions}
            </span>
            <span>{connectionState}</span>
          </div>

          <div className="multiplayer-option-grid">
            {currentQuestion.options.map((option, index) => {
              const revealResult = revealMap.get(currentUserId);
              const isSubmitted = currentQuestion.has_answered || submittingAnswer;
              const isSelected = revealResult?.selected_option_index === index;
              const isCorrect = reveal?.correct_answer_index === index;
              const isWrong = Boolean(reveal && isSelected && !revealResult?.is_correct);

              return (
                <button
                  key={`${currentQuestion.id}-${option}`}
                  type="button"
                  className={`multiplayer-option-btn ${isSelected ? "is-selected" : ""} ${
                    isCorrect ? "is-correct" : ""
                  } ${isWrong ? "is-wrong" : ""}`}
                  onClick={() => onSubmitAnswer(currentQuestion.id, index)}
                  disabled={isSubmitted || room.room.status !== "in_progress"}
                >
                  <span className="multiplayer-option-index">{["A", "B", "C", "D"][index]}</span>
                  <span>{option}</span>
                </button>
              );
            })}
          </div>

          {currentQuestion.has_answered ? (
            <div className="multiplayer-answer-lock">
              <strong>Answer locked.</strong>
              <p>Waiting for the timer or remaining players before the reveal.</p>
            </div>
          ) : null}

          {reveal ? (
            <div className="multiplayer-reveal-card">
              <strong>Correct answer: {reveal.correct_option}</strong>
              <p>{reveal.explanation || "The round is resolving and scores are updating."}</p>
            </div>
          ) : null}

          {statusMessage ? <p className="multiplayer-status-note">{statusMessage}</p> : null}

          <div className="multiplayer-player-footer">
            <article>
              <span>Your score</span>
              <strong>{currentPlayer?.score ?? 0}</strong>
            </article>
            <article>
              <span>Correct</span>
              <strong>{currentPlayer?.correct_answers ?? 0}</strong>
            </article>
            <article>
              <span>Accuracy</span>
              <strong>{currentPlayer?.accuracy ?? 0}%</strong>
            </article>
          </div>
        </article>
      </div>

      <aside className="multiplayer-room-side">
        <LiveLeaderboard leaderboard={leaderboard} />
      </aside>
    </section>
  );
}

export default MultiplayerGame;
