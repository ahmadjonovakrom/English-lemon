function LiveLeaderboard({ leaderboard, compact = false }) {
  return (
    <section className={`multiplayer-leaderboard ${compact ? "is-compact" : ""}`}>
      <div className="multiplayer-section-head">
        <h2>Live Leaderboard</h2>
      </div>
      <div className="multiplayer-leaderboard-list">
        {leaderboard.map((entry) => (
          <article key={entry.player_id} className="multiplayer-leaderboard-row">
            <div className="multiplayer-leaderboard-user">
              <span className="multiplayer-avatar">{entry.display_name?.slice(0, 1) || "P"}</span>
              <div>
                <strong>{entry.display_name}</strong>
                <p>
                  {entry.correct_answers} correct • {entry.accuracy}% accuracy
                </p>
              </div>
            </div>
            <div className="multiplayer-leaderboard-score">
              <span>#{entry.rank}</span>
              <strong>{entry.score}</strong>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export default LiveLeaderboard;
