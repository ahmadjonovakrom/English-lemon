import api, { buildWebSocketUrl, getAuthToken } from "./client";

export function listNotifications() {
  return api.get("/notifications");
}

export function getUnreadNotificationsCount() {
  return api.get("/notifications/unread-count");
}

export function markNotificationRead(notificationId) {
  return api.patch(`/notifications/${notificationId}/read`);
}

export function markAllNotificationsRead() {
  return api.patch("/notifications/read-all");
}

export function deleteNotification(notificationId) {
  return api.delete(`/notifications/${notificationId}`);
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
