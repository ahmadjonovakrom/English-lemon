import api from "./client";

export function getMyProfile() {
  return api.get("/users/me");
}

export function updateMyProfile(payload) {
  return api.patch("/users/me", payload);
}

export function getMyStats() {
  return api.get("/users/me/stats");
}

export function syncMyStats(payload) {
  return api.put("/users/me/stats", payload);
}

export function getMyActivity() {
  return api.get("/users/me/activity");
}

export function getPublicProfile(userId) {
  return api.get(`/users/${userId}`);
}

export function getPublicStats(userId) {
  return api.get(`/users/${userId}/stats`);
}

export function getPublicActivity(userId) {
  return api.get(`/users/${userId}/activity`);
}
