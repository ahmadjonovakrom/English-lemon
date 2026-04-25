import api, { buildWebSocketUrl, getAuthToken } from "./client";

export function listRooms({ status } = {}) {
  const search = new URLSearchParams();
  if (status) {
    search.set("status", status);
  }
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return api.get(`/rooms${suffix}`);
}

export function createRoom(payload) {
  return api.post("/rooms", payload);
}

export function getRoom(roomId) {
  return api.get(`/rooms/${roomId}`);
}

export function joinRoom(roomId) {
  return api.post(`/rooms/${roomId}/join`);
}

export function joinRoomByCode(roomCode) {
  return api.post("/rooms/join-by-code", { room_code: roomCode });
}

export function leaveRoom(roomId) {
  return api.post(`/rooms/${roomId}/leave`);
}

export function startRoom(roomId) {
  return api.post(`/rooms/${roomId}/start`);
}

export function getRoomResults(roomId) {
  return api.get(`/rooms/${roomId}/results`);
}

export function inviteFriendToRoom(roomId, friendUserId) {
  return api.post(`/rooms/${roomId}/invite`, { friend_user_id: friendUserId });
}

export function createRoomSocket(roomId) {
  const token = getAuthToken();
  if (!token || typeof WebSocket === "undefined") {
    return null;
  }

  const connectionId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `room-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return new WebSocket(
    buildWebSocketUrl(`/rooms/ws/${roomId}`, {
      token,
      connection_id: connectionId
    })
  );
}
