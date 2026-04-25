function MultiplayerResults({ results, onPlayAgain, onBackToRooms }) {
  const winner = results?.winner;

  return (
    <section className="multiplayer-room-view">
      <div className="multiplayer-room-main">
        <article className="multiplayer-panel multiplayer-results-hero">
          <p className="brand-mark">Final Results</p>
          <h1>{winner ? `${winner.display_name} wins the room` : "Room finished"}</h1>
          <p className="subtle-text">
            Final rankings, XP gains, and lemon rewards are ready for everyone in the room.
          </p>
        </article>

        <article className="multiplayer-panel">
          <div className="multiplayer-results-list">
            {results?.rankings?.map((entry) => (
              <article key={entry.player_id} className="multiplayer-result-row">
                <div className="multiplayer-leaderboard-user">
                  <span className="multiplayer-avatar">{entry.display_name.slice(0, 1)}</span>
                  <div>
                    <strong>
                      #{entry.rank} {entry.display_name}
                    </strong>
                    <p>
                      {entry.correct_answers}/{results.total_questions} correct • {entry.accuracy}% accuracy
                    </p>
                  </div>
                </div>
                <div className="multiplayer-result-stats">
                  <span>{entry.score} XP</span>
                  <strong>{entry.lemons_earned} lemons</strong>
                </div>
              </article>
            ))}
          </div>

          <div className="multiplayer-results-actions">
            <button type="button" className="primary-btn" onClick={onPlayAgain}>
              Play Again
            </button>
            <button type="button" className="secondary-btn" onClick={onBackToRooms}>
              Back to Rooms
            </button>
          </div>
        </article>
      </div>
    </section>
  );
}

export default MultiplayerResults;
