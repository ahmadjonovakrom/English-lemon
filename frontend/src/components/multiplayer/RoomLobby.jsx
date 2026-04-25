function RoomLobby({
  room,
  players,
  isHost,
  connectionState,
  startLoading,
  leaveLoading,
  inviteLoading,
  inviteFriends,
  inviteFriendId,
  onInviteFriendChange,
  onInviteFriend,
  onStart,
  onLeave,
  onCopyCode
}) {
  const countdownEndsAt = room?.game?.countdown_ends_at;
  const countdownLabel = countdownEndsAt
    ? Math.max(0, Math.ceil((new Date(countdownEndsAt).getTime() - Date.now()) / 1000))
    : 0;

  return (
    <section className="multiplayer-room-view">
      <div className="multiplayer-room-main">
        <article className="multiplayer-panel multiplayer-room-hero">
          <div className="multiplayer-room-hero-top">
            <div>
              <p className="brand-mark">Real-Time Quiz Room</p>
              <h1>{room.room.title}</h1>
              <p className="subtle-text">
                Code {room.room.room_code} • {room.room.category} • {room.room.difficulty} •{" "}
                {room.room.question_count} questions
              </p>
            </div>
            <div className="multiplayer-room-actions">
              <button type="button" className="secondary-btn" onClick={onCopyCode}>
                Copy Invite Code
              </button>
              <button type="button" className="secondary-btn" onClick={onLeave} disabled={leaveLoading}>
                {leaveLoading ? "Leaving..." : "Leave Room"}
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={onStart}
                disabled={!isHost || startLoading || room.room.status !== "waiting"}
              >
                {room.room.status === "starting"
                  ? `Starting in ${countdownLabel || 0}`
                  : startLoading
                    ? "Starting..."
                    : isHost
                      ? "Start Game"
                      : "Host Starts Game"}
              </button>
            </div>
          </div>

          <div className="multiplayer-room-stats">
            <article>
              <span>Players</span>
              <strong>
                {room.room.joined_players}/{room.room.max_players}
              </strong>
            </article>
            <article>
              <span>Connected</span>
              <strong>{room.room.connected_players}</strong>
            </article>
            <article>
              <span>Host</span>
              <strong>{room.room.host?.display_name || room.room.host?.username || "--"}</strong>
            </article>
            <article>
              <span>Socket</span>
              <strong>{connectionState}</strong>
            </article>
          </div>
        </article>

        <article className="multiplayer-panel">
          <div className="multiplayer-section-head">
            <h2>Lobby Players</h2>
            <span className="multiplayer-inline-pill">{players.length} joined</span>
          </div>

          <div className="multiplayer-player-list">
            {players.map((player) => (
              <article key={player.id} className="multiplayer-player-card">
                <div className="multiplayer-player-user">
                  <span className="multiplayer-avatar">{player.user.display_name.slice(0, 1)}</span>
                  <div>
                    <strong>{player.user.display_name}</strong>
                    <p>@{player.user.username}</p>
                  </div>
                </div>
                <div className="multiplayer-player-badges">
                  {player.is_host ? <span className="multiplayer-inline-pill is-host">Host</span> : null}
                  <span className={`multiplayer-inline-pill ${player.is_connected ? "is-live" : "is-offline"}`}>
                    {player.is_connected ? "Online" : "Disconnected"}
                  </span>
                  <span className={`multiplayer-inline-pill ${player.is_ready ? "is-ready" : ""}`}>
                    {player.is_ready ? "Ready" : "Waiting"}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </article>
      </div>

      <aside className="multiplayer-room-side">
        <article className="multiplayer-panel">
          <div className="multiplayer-section-head">
            <h2>Invite Friends</h2>
          </div>

          {inviteFriends.length ? (
            <div className="multiplayer-invite-box">
              <select value={inviteFriendId} onChange={(event) => onInviteFriendChange(event.target.value)}>
                <option value="">Choose friend</option>
                {inviteFriends.map((friend) => (
                  <option key={friend.id} value={friend.id}>
                    {friend.display_name || friend.username}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="primary-btn"
                onClick={onInviteFriend}
                disabled={inviteLoading || !inviteFriendId}
              >
                {inviteLoading ? "Inviting..." : "Send Invite"}
              </button>
            </div>
          ) : (
            <p className="subtle-text">
              Friend invites appear here when your Social Arena friend list is available.
            </p>
          )}
        </article>
      </aside>
    </section>
  );
}

export default RoomLobby;
