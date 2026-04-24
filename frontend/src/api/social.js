import api, { buildWebSocketUrl, getAuthToken } from "./client";

export function searchUsers(query) {
  return api.get(`/social/users/search?q=${encodeURIComponent(query)}`);
}

export function listFriends() {
  return api.get("/social/friends");
}

export function listFriendRequests() {
  return api.get("/social/requests");
}

export function sendFriendRequest(receiverId) {
  return api.post("/social/requests", { receiver_id: receiverId });
}

export function cancelFriendRequest(requestId) {
  return api.post(`/social/requests/${requestId}/cancel`);
}

export function acceptFriendRequest(requestId) {
  return api.post(`/social/requests/${requestId}/accept`);
}

export function declineFriendRequest(requestId) {
  return api.post(`/social/requests/${requestId}/decline`);
}

export function removeFriend(friendId) {
  return api.delete(`/social/friends/${friendId}`);
}

export function listConversations() {
  return api.get("/social/conversations");
}

export function createOrGetDirectConversation(friendId) {
  return api.post("/social/conversations/direct", { friend_id: friendId });
}

export function listConversationMessages(conversationId, { limit = 60 } = {}) {
  return api.get(`/social/conversations/${conversationId}/messages?limit=${limit}`);
}

export function sendConversationMessage(conversationId, body) {
  return api.post(`/social/conversations/${conversationId}/messages`, { body });
}

export function sendConversationVoiceMessage(
  conversationId,
  audioFile,
  { durationSeconds } = {}
) {
  const formData = new FormData();
  formData.append("audio", audioFile);

  if (Number.isFinite(durationSeconds) && durationSeconds >= 0) {
    formData.append("duration_seconds", String(Math.round(durationSeconds)));
  }

  return api.post(`/social/conversations/${conversationId}/voice-messages`, formData, {
    timeout: 45000
  });
}

export function markConversationSeen(conversationId) {
  return api.post(`/social/conversations/${conversationId}/messages/seen`);
}

export function getConversationUnreadCount() {
  return api.get("/social/conversations/unread-count");
}

export function createConversationChallenge(conversationId, payload) {
  return api.post(`/social/conversations/${conversationId}/challenges`, payload);
}

export function startConversationCall(conversationId, offerSdp) {
  const offerDescription =
    offerSdp && typeof offerSdp === "object"
      ? offerSdp
      : { type: "offer", sdp: offerSdp };
  return api.post(`/social/conversations/${conversationId}/calls/start`, {
    type: "offer",
    sdp: offerDescription
  });
}

export function getLatestConversationCall(conversationId) {
  return api.get(`/social/conversations/${conversationId}/calls/latest`);
}

export function listIncomingCalls({ limit = 10 } = {}) {
  return api.get(`/social/calls/incoming?limit=${limit}`);
}

export function acceptCall(callId, answerSdp) {
  const answerDescription =
    answerSdp && typeof answerSdp === "object"
      ? answerSdp
      : { type: "answer", sdp: answerSdp };
  return api.post(`/social/calls/${callId}/accept`, {
    type: "answer",
    sdp: answerDescription
  });
}

export function declineCall(callId) {
  return api.post(`/social/calls/${callId}/decline`);
}

export function cancelCall(callId) {
  return api.post(`/social/calls/${callId}/cancel`);
}

export function activateCall(callId) {
  return api.post(`/social/calls/${callId}/activate`);
}

export function endCall(callId) {
  return api.post(`/social/calls/${callId}/end`);
}

export function addCallCandidate(callId, candidate) {
  return api.post(`/social/calls/${callId}/candidates`, {
    type: "candidate",
    candidate
  });
}

export function listConversationChallenges(conversationId, { limit = 60 } = {}) {
  return api.get(`/social/conversations/${conversationId}/challenges?limit=${limit}`);
}

export function acceptChallenge(challengeId) {
  return api.post(`/social/challenges/${challengeId}/accept`);
}

export function declineChallenge(challengeId) {
  return api.post(`/social/challenges/${challengeId}/decline`);
}

export function cancelChallenge(challengeId) {
  return api.post(`/social/challenges/${challengeId}/cancel`);
}

export function listNotifications({ limit = 30 } = {}) {
  return api.get(`/social/notifications?limit=${limit}`);
}

export function getNotificationUnreadCount() {
  return api.get("/social/notifications/unread-count");
}

export function markNotificationRead(notificationId) {
  return api.post(`/social/notifications/${notificationId}/read`);
}

export function markAllNotificationsRead() {
  return api.post("/social/notifications/read-all");
}

export function createNotificationsSocket() {
  const token = getAuthToken();
  if (!token || typeof WebSocket === "undefined") {
    return null;
  }
  const connectionId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `notifications-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new WebSocket(
    buildWebSocketUrl("/notifications/ws", {
      token,
      connection_id: connectionId
    })
  );
}

export function listPresence(userIds = []) {
  const ids = [...new Set(userIds.filter((id) => Number.isFinite(Number(id))).map(Number))];
  if (!ids.length) {
    return Promise.resolve({ users: [] });
  }
  return api.get(`/presence/users?ids=${encodeURIComponent(ids.join(","))}`);
}

export function createPresenceSocket() {
  const token = getAuthToken();
  if (!token || typeof WebSocket === "undefined") {
    return null;
  }
  const connectionId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `presence-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new WebSocket(
    buildWebSocketUrl("/presence/ws", {
      token,
      connection_id: connectionId
    })
  );
}
