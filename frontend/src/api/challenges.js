import api from "./client";

export function listChallenges({ status, limit = 60 } = {}) {
  const query = new URLSearchParams();
  if (status) {
    query.set("status", status);
  }
  if (limit) {
    query.set("limit", String(limit));
  }
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return api.get(`/social/challenges${suffix}`);
}

export function listIncomingChallenges({ limit = 60 } = {}) {
  return api.get(`/social/challenges/incoming?limit=${limit}`);
}

export function listOutgoingChallenges({ limit = 60 } = {}) {
  return api.get(`/social/challenges/outgoing?limit=${limit}`);
}

export function getChallenge(challengeId) {
  return api.get(`/social/challenges/${challengeId}`);
}

export function createChallenge(payload) {
  return api.post("/social/challenges", payload);
}

export function acceptChallengeInvite(challengeId) {
  return api.patch(`/social/challenges/${challengeId}/accept`);
}

export function declineChallengeInvite(challengeId) {
  return api.patch(`/social/challenges/${challengeId}/decline`);
}

export function startChallenge(challengeId) {
  return api.post(`/social/challenges/${challengeId}/start`);
}

export function submitChallenge(challengeId, payload) {
  return api.post(`/social/challenges/${challengeId}/submit`, payload);
}

export function rematchChallenge(challengeId) {
  return api.post(`/social/challenges/${challengeId}/rematch`);
}
