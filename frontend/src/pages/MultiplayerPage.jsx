import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  createRoom,
  getRoom,
  getRoomResults,
  inviteFriendToRoom,
  joinRoom,
  joinRoomByCode,
  leaveRoom,
  listRooms,
  startRoom
} from "../api/rooms";
import { listFriends } from "../api/social";
import CreateRoomModal from "../components/multiplayer/CreateRoomModal";
import MultiplayerGame from "../components/multiplayer/MultiplayerGame";
import MultiplayerResults from "../components/multiplayer/MultiplayerResults";
import RoomCard from "../components/multiplayer/RoomCard";
import RoomLobby from "../components/multiplayer/RoomLobby";
import { useAuth } from "../context/AuthContext";
import { useRoomSocket } from "../features/multiplayer/useRoomSocket";
import "../features/multiplayer/multiplayer.css";

function MultiplayerPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [rooms, setRooms] = useState([]);
  const [roomDetail, setRoomDetail] = useState(null);
  const [results, setResults] = useState(null);
  const [friends, setFriends] = useState([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [loadingRoom, setLoadingRoom] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState({ start: false, leave: false, invite: false, answer: false });
  const [pageError, setPageError] = useState("");
  const [createError, setCreateError] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinCodeLoading, setJoinCodeLoading] = useState(false);
  const [inviteFriendId, setInviteFriendId] = useState("");
  const [statusMessage, setStatusMessage] = useState("");

  const activeRoomId = roomId ? Number(roomId) : null;

  const { connectionState, socketError, sendMessage } = useRoomSocket({
    roomId: activeRoomId,
    enabled: Boolean(activeRoomId),
    onMessage: (payload) => {
      if (payload.type === "room.snapshot" && payload.payload) {
        setRoomDetail(payload.payload);
      }
      if (payload.type === "player.joined") {
        setStatusMessage("A player joined the room.");
      }
      if (payload.type === "player.left") {
        setStatusMessage("A player disconnected from the room.");
      }
      if (payload.type === "countdown.started") {
        setStatusMessage("Match countdown started.");
      }
      if (payload.type === "question.started") {
        setStatusMessage("New question is live.");
      }
      if (payload.type === "question.revealed") {
        setStatusMessage("Round resolved. Scores updated.");
      }
      if (payload.type === "game.ended" && payload.payload) {
        setResults(payload.payload);
        setStatusMessage("Game finished. Final leaderboard ready.");
      }
      if (payload.type === "error" && payload.message) {
        setStatusMessage(payload.message);
      }
    }
  });

  useEffect(() => {
    if (!activeRoomId) {
      setLoadingRooms(true);
      listRooms()
        .then((response) => {
          setRooms(response.rooms || []);
          setPageError("");
        })
        .catch((error) => {
          setPageError(error?.detail || error?.message || "Failed to load rooms.");
        })
        .finally(() => setLoadingRooms(false));
      return;
    }

    setLoadingRoom(true);
    Promise.all([
      getRoom(activeRoomId),
      listFriends().catch(() => ({ friends: [] }))
    ])
      .then(([roomResponse, friendsResponse]) => {
        setRoomDetail(roomResponse);
        setResults(roomResponse.results || null);
        setFriends(friendsResponse.friends || []);
        setPageError("");
      })
      .catch((error) => {
        setPageError(error?.detail || error?.message || "Failed to load room.");
      })
      .finally(() => setLoadingRoom(false));
  }, [activeRoomId]);

  const currentUserId = user?.id;
  const isHost = useMemo(
    () => roomDetail?.room?.host_id === currentUserId,
    [currentUserId, roomDetail]
  );

  const availableInviteFriends = useMemo(() => {
    const joinedIds = new Set((roomDetail?.players || []).map((player) => player.user_id));
    return friends.filter((friend) => !joinedIds.has(friend.id));
  }, [friends, roomDetail]);

  const handleCreateRoom = async (payload) => {
    setCreateLoading(true);
    setCreateError("");
    try {
      const response = await createRoom(payload);
      setCreateOpen(false);
      navigate(`/multiplayer/${response.room.id}`);
    } catch (error) {
      setCreateError(error?.detail || error?.message || "Failed to create room.");
    } finally {
      setCreateLoading(false);
    }
  };

  const handleJoinRoom = async (selectedRoomId) => {
    setPageError("");
    try {
      const response = await joinRoom(selectedRoomId);
      navigate(`/multiplayer/${response.room.id}`);
    } catch (error) {
      setPageError(error?.detail || error?.message || "Failed to join room.");
    }
  };

  const handleJoinByCode = async (event) => {
    event.preventDefault();
    setJoinCodeLoading(true);
    setPageError("");
    try {
      const response = await joinRoomByCode(joinCode.trim().toUpperCase());
      navigate(`/multiplayer/${response.room.id}`);
    } catch (error) {
      setPageError(error?.detail || error?.message || "Failed to join room by code.");
    } finally {
      setJoinCodeLoading(false);
    }
  };

  const handleStartRoom = async () => {
    if (!activeRoomId) {
      return;
    }
    setActionLoading((previous) => ({ ...previous, start: true }));
    try {
      const response = await startRoom(activeRoomId);
      setRoomDetail(response);
      setStatusMessage("Countdown started.");
    } catch (error) {
      setStatusMessage(error?.detail || error?.message || "Unable to start room.");
    } finally {
      setActionLoading((previous) => ({ ...previous, start: false }));
    }
  };

  const handleLeaveRoom = async () => {
    if (!activeRoomId) {
      return;
    }
    setActionLoading((previous) => ({ ...previous, leave: true }));
    try {
      await leaveRoom(activeRoomId);
      navigate("/multiplayer");
    } catch (error) {
      setStatusMessage(error?.detail || error?.message || "Unable to leave room.");
    } finally {
      setActionLoading((previous) => ({ ...previous, leave: false }));
    }
  };

  const handleSubmitAnswer = async (questionId, selectedOptionIndex) => {
    setActionLoading((previous) => ({ ...previous, answer: true }));
    try {
      sendMessage({
        type: "answer.submit",
        question_id: questionId,
        selected_option_index: selectedOptionIndex
      });
      setStatusMessage("Answer submitted.");
    } catch (error) {
      setStatusMessage(error?.message || "Failed to send answer.");
    } finally {
      setActionLoading((previous) => ({ ...previous, answer: false }));
    }
  };

  const handleInviteFriend = async () => {
    if (!activeRoomId || !inviteFriendId) {
      return;
    }
    setActionLoading((previous) => ({ ...previous, invite: true }));
    try {
      await inviteFriendToRoom(activeRoomId, Number(inviteFriendId));
      setStatusMessage("Friend invitation sent.");
      setInviteFriendId("");
    } catch (error) {
      setStatusMessage(error?.detail || error?.message || "Failed to invite friend.");
    } finally {
      setActionLoading((previous) => ({ ...previous, invite: false }));
    }
  };

  const handleRefreshResults = async () => {
    if (!activeRoomId) {
      navigate("/multiplayer");
      return;
    }
    try {
      const response = await getRoomResults(activeRoomId);
      setResults(response);
    } catch (error) {
      setStatusMessage(error?.detail || error?.message || "Failed to load results.");
    }
  };

  const handleCopyCode = async () => {
    const roomCode = roomDetail?.room?.room_code;
    if (!roomCode) {
      return;
    }
    try {
      await navigator.clipboard.writeText(roomCode);
      setStatusMessage("Room code copied.");
    } catch {
      setStatusMessage(`Copy this room code manually: ${roomCode}`);
    }
  };

  if (!activeRoomId) {
    return (
      <main className="page-shell multiplayer-page">
        <section className="multiplayer-shell">
          <header className="multiplayer-header">
            <div>
              <p className="brand-mark">English Lemon</p>
              <h1>Multiplayer Quiz Rooms</h1>
              <p className="subtle-text">
                Build a room, invite friends, and run a live quiz battle with synced questions and scores.
              </p>
            </div>
            <div className="multiplayer-header-actions">
              <button type="button" className="secondary-btn" onClick={() => navigate("/dashboard")}>
                Dashboard
              </button>
              <button type="button" className="primary-btn" onClick={() => setCreateOpen(true)}>
                Create Room
              </button>
            </div>
          </header>

          <section className="multiplayer-join-strip multiplayer-panel">
            <form className="multiplayer-code-form" onSubmit={handleJoinByCode}>
              <label>
                Join by code
                <input
                  value={joinCode}
                  onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                  placeholder="Enter room code"
                  maxLength={8}
                />
              </label>
              <button type="submit" className="primary-btn" disabled={joinCodeLoading || !joinCode.trim()}>
                {joinCodeLoading ? "Joining..." : "Join by Code"}
              </button>
            </form>
          </section>

          {pageError ? <p className="error-text">{pageError}</p> : null}

          <section className="multiplayer-room-grid">
            {loadingRooms ? (
              <article className="multiplayer-panel multiplayer-empty-state">
                <h2>Loading rooms</h2>
                <p className="subtle-text">Checking for live lobbies and active quiz matches.</p>
              </article>
            ) : rooms.length ? (
              rooms.map((room) => <RoomCard key={room.id} room={room} onJoin={handleJoinRoom} />)
            ) : (
              <article className="multiplayer-panel multiplayer-empty-state">
                <h2>No rooms available</h2>
                <p className="subtle-text">Create the first room and start a live English battle.</p>
              </article>
            )}
          </section>

          <CreateRoomModal
            open={createOpen}
            loading={createLoading}
            error={createError}
            onClose={() => setCreateOpen(false)}
            onCreate={handleCreateRoom}
          />
        </section>
      </main>
    );
  }

  if (loadingRoom || !roomDetail) {
    return (
      <main className="page-shell multiplayer-page">
        <section className="multiplayer-shell">
          <article className="multiplayer-panel multiplayer-empty-state">
            <h2>Loading room</h2>
            <p className="subtle-text">Syncing lobby state and live quiz data.</p>
          </article>
        </section>
      </main>
    );
  }

  const effectiveResults = results || roomDetail.results;

  return (
    <main className="page-shell multiplayer-page">
      <section className="multiplayer-shell">
        <header className="multiplayer-header">
          <div>
            <p className="brand-mark">English Lemon</p>
            <h1>{roomDetail.room.title}</h1>
            <p className="subtle-text">
              Room {roomDetail.room.room_code} • socket {connectionState}
              {socketError ? ` • ${socketError}` : ""}
            </p>
          </div>
          <div className="multiplayer-header-actions">
            <button type="button" className="secondary-btn" onClick={() => navigate("/multiplayer")}>
              Back to Rooms
            </button>
          </div>
        </header>

        {pageError ? <p className="error-text">{pageError}</p> : null}

        {roomDetail.room.status === "waiting" || roomDetail.room.status === "starting" ? (
          <RoomLobby
            room={roomDetail}
            players={roomDetail.players}
            isHost={isHost}
            connectionState={connectionState}
            startLoading={actionLoading.start}
            leaveLoading={actionLoading.leave}
            inviteLoading={actionLoading.invite}
            inviteFriends={availableInviteFriends}
            inviteFriendId={inviteFriendId}
            onInviteFriendChange={setInviteFriendId}
            onInviteFriend={handleInviteFriend}
            onStart={handleStartRoom}
            onLeave={handleLeaveRoom}
            onCopyCode={handleCopyCode}
          />
        ) : null}

        {roomDetail.room.status === "in_progress" ? (
          <MultiplayerGame
            room={roomDetail}
            players={roomDetail.players}
            currentUserId={currentUserId}
            connectionState={connectionState}
            submittingAnswer={actionLoading.answer}
            statusMessage={statusMessage}
            onSubmitAnswer={handleSubmitAnswer}
          />
        ) : null}

        {roomDetail.room.status === "completed" || roomDetail.room.status === "cancelled" ? (
          <MultiplayerResults
            results={effectiveResults}
            onPlayAgain={handleRefreshResults}
            onBackToRooms={() => navigate("/multiplayer")}
          />
        ) : null}
      </section>
    </main>
  );
}

export default MultiplayerPage;
