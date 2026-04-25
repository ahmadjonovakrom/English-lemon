function formatDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "--";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(parsed);
}

function RoomCard({ room, onJoin }) {
  return (
    <article className="multiplayer-room-card">
      <div className="multiplayer-room-card-top">
        <div>
          <p className="multiplayer-room-code">{room.room_code}</p>
          <h3>{room.title}</h3>
        </div>
        <span className={`multiplayer-status-pill is-${room.status}`}>{room.status.replace("_", " ")}</span>
      </div>

      <div className="multiplayer-room-meta">
        <span>{room.category}</span>
        <span>{room.difficulty}</span>
        <span>{room.question_count} questions</span>
        <span>
          {room.joined_players}/{room.max_players} players
        </span>
      </div>

      <div className="multiplayer-room-foot">
        <div>
          <p className="multiplayer-room-host">
            Host: {room.host?.display_name || room.host?.username || "Waiting for host"}
          </p>
          <p className="multiplayer-room-created">Created {formatDate(room.created_at)}</p>
        </div>
        <button
          type="button"
          className="primary-btn multiplayer-room-join-btn"
          onClick={() => onJoin(room.id)}
          disabled={room.status === "completed" || room.status === "cancelled"}
        >
          {room.status === "waiting" ? "Join Room" : "Open Room"}
        </button>
      </div>
    </article>
  );
}

export default RoomCard;
