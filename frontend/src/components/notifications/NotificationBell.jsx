import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  createNotificationsSocket,
  deleteNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead
} from "../../api/notifications";

const SOCKET_HEARTBEAT_MS = 22000;
const SOCKET_RECONNECT_MS = 3200;

const TYPE_META = {
  new_friend_request: { icon: "+", tone: "yellow" },
  friend_request_accepted: { icon: "✓", tone: "green" },
  new_message: { icon: "M", tone: "blue" },
  new_voice_message: { icon: "V", tone: "yellow" },
  challenge_received: { icon: "Q", tone: "yellow" },
  challenge_accepted: { icon: "Q", tone: "green" },
  challenge_declined: { icon: "Q", tone: "red" },
  challenge_canceled: { icon: "Q", tone: "red" },
  challenge_result: { icon: "Q", tone: "blue" },
  achievement_unlocked: { icon: "★", tone: "yellow" },
  quiz_result: { icon: "R", tone: "blue" },
  call_incoming: { icon: "C", tone: "green" },
  call_missed: { icon: "!", tone: "red" },
  call_accepted: { icon: "C", tone: "green" },
  call_declined: { icon: "!", tone: "red" },
  call_canceled: { icon: "C", tone: "red" }
};

function formatRelativeTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "just now";
  }

  const diffMs = Date.now() - parsed.getTime();
  if (diffMs < 60_000) {
    return "just now";
  }
  if (diffMs < 60 * 60_000) {
    return `${Math.max(1, Math.round(diffMs / 60_000))}m ago`;
  }
  if (diffMs < 24 * 60 * 60_000) {
    return `${Math.max(1, Math.round(diffMs / (60 * 60_000)))}h ago`;
  }
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function getMeta(type) {
  return TYPE_META[type] ?? { icon: "•", tone: "default" };
}

function NotificationBell({ compact = false }) {
  const navigate = useNavigate();
  const panelRef = useRef(null);
  const socketRef = useRef(null);
  const reconnectTimerRef = useRef(0);
  const heartbeatRef = useRef(0);

  const [isOpen, setIsOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [socketState, setSocketState] = useState("connecting");
  const [actionKey, setActionKey] = useState("");

  const sortedItems = useMemo(
    () =>
      [...items].sort(
        (first, second) => new Date(second.created_at).getTime() - new Date(first.created_at).getTime()
      ),
    [items]
  );

  const loadNotifications = async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
    }
    try {
      const response = await listNotifications();
      setItems(Array.isArray(response?.notifications) ? response.notifications : []);
      setUnreadCount(Number.isFinite(response?.unread_count) ? response.unread_count : 0);
      setError("");
    } catch (loadError) {
      setError(loadError?.detail || loadError?.message || "Unable to load notifications.");
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadNotifications();
  }, []);

  useEffect(() => {
    let disposed = false;

    const clearTimers = () => {
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = 0;
      }
      if (heartbeatRef.current) {
        window.clearInterval(heartbeatRef.current);
        heartbeatRef.current = 0;
      }
    };

    const closeSocket = () => {
      clearTimers();
      if (socketRef.current) {
        socketRef.current.onopen = null;
        socketRef.current.onmessage = null;
        socketRef.current.onerror = null;
        socketRef.current.onclose = null;
        socketRef.current.close();
        socketRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimerRef.current) {
        return;
      }
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = 0;
        connectSocket();
      }, SOCKET_RECONNECT_MS);
    };

    const connectSocket = () => {
      closeSocket();
      const socket = createNotificationsSocket();
      if (!socket) {
        setSocketState("unavailable");
        return;
      }

      socketRef.current = socket;
      setSocketState("connecting");

      socket.onopen = () => {
        setSocketState("live");
        heartbeatRef.current = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "heartbeat" }));
          }
        }, SOCKET_HEARTBEAT_MS);
      };

      socket.onmessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (payload?.type === "notification" && payload.notification) {
          setItems((previous) => {
            const withoutDuplicate = previous.filter((item) => item.id !== payload.notification.id);
            return [payload.notification, ...withoutDuplicate].slice(0, 25);
          });
          if (Number.isFinite(payload.unread_count)) {
            setUnreadCount(payload.unread_count);
          } else if (!payload.notification.is_read) {
            setUnreadCount((previous) => previous + 1);
          }
          return;
        }

        if (payload?.type === "unread_count" && Number.isFinite(payload.unread_count)) {
          setUnreadCount(payload.unread_count);
        }
      };

      socket.onerror = () => setSocketState("reconnecting");
      socket.onclose = () => {
        clearTimers();
        if (!disposed) {
          setSocketState("reconnecting");
          scheduleReconnect();
        }
      };
    };

    connectSocket();
    return () => {
      disposed = true;
      closeSocket();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (panelRef.current && !panelRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  const navigateFromNotification = async (notification) => {
    if (!notification.is_read) {
      await handleMarkRead(notification.id, { silent: true });
    }

    if (notification.related_entity_type === "challenge" && notification.related_entity_id) {
      navigate(`/challenges/${notification.related_entity_id}`);
      setIsOpen(false);
      return;
    }

    if (notification.related_entity_type === "conversation") {
      navigate("/social", {
        state: {
          conversationId:
            notification.metadata?.related_conversation_id ??
            notification.related_entity_id ??
            notification.metadata?.conversation_id ??
            null
        }
      });
      setIsOpen(false);
      return;
    }

    if (notification.related_entity_type === "user" && notification.related_entity_id) {
      navigate(`/users/${notification.related_entity_id}`);
      setIsOpen(false);
      return;
    }

    if (notification.type === "achievement_unlocked" || notification.type === "quiz_result") {
      navigate("/profile");
      setIsOpen(false);
      return;
    }
  };

  const handleMarkRead = async (notificationId, { silent = false } = {}) => {
    setActionKey(`read-${notificationId}`);
    try {
      await markNotificationRead(notificationId);
      setItems((previous) =>
        previous.map((item) => (item.id === notificationId ? { ...item, is_read: true } : item))
      );
      setUnreadCount((previous) => Math.max(0, previous - 1));
      if (!silent) {
        setError("");
      }
    } catch (markError) {
      setError(markError?.detail || markError?.message || "Unable to update notification.");
    } finally {
      setActionKey("");
    }
  };

  const handleMarkAllRead = async () => {
    setActionKey("read-all");
    try {
      await markAllNotificationsRead();
      setItems((previous) => previous.map((item) => ({ ...item, is_read: true })));
      setUnreadCount(0);
    } catch (markError) {
      setError(markError?.detail || markError?.message || "Unable to update notifications.");
    } finally {
      setActionKey("");
    }
  };

  const handleDelete = async (notificationId) => {
    setActionKey(`delete-${notificationId}`);
    try {
      const current = items.find((item) => item.id === notificationId);
      await deleteNotification(notificationId);
      setItems((previous) => previous.filter((item) => item.id !== notificationId));
      if (current && !current.is_read) {
        setUnreadCount((previous) => Math.max(0, previous - 1));
      }
    } catch (deleteError) {
      setError(deleteError?.detail || deleteError?.message || "Unable to delete notification.");
    } finally {
      setActionKey("");
    }
  };

  return (
    <div
      ref={panelRef}
      className={`app-notification-shell ${compact ? "is-compact" : ""}`}
    >
      <button
        type="button"
        className={`secondary-btn app-notification-trigger ${isOpen ? "is-open" : ""}`}
        onClick={() => {
          setIsOpen((current) => !current);
          if (!isOpen) {
            void loadNotifications({ silent: true });
          }
        }}
        aria-label="Open notifications"
      >
        <span className="app-notification-bell" aria-hidden="true">
          ◌
        </span>
        {!compact ? <span>Notifications</span> : null}
        {unreadCount > 0 ? (
          <span className="app-notification-count">{unreadCount}</span>
        ) : null}
      </button>

      {isOpen ? (
        <div className="app-notification-panel">
          <div className="app-notification-panel-head">
            <div>
              <h3>Notifications</h3>
              <span className={`app-notification-live is-${socketState}`}>
                {socketState === "live"
                  ? "Live"
                  : socketState === "reconnecting"
                    ? "Reconnecting"
                    : socketState === "unavailable"
                      ? "Offline"
                      : "Syncing"}
              </span>
            </div>
            <button
              type="button"
              className="secondary-btn app-notification-mini-btn"
              onClick={handleMarkAllRead}
              disabled={unreadCount === 0 || actionKey === "read-all"}
            >
              {actionKey === "read-all" ? "Saving..." : "Mark All"}
            </button>
          </div>

          {loading ? <p className="subtle-text">Loading notifications...</p> : null}
          {error ? <p className="error-text">{error}</p> : null}
          {!loading && !error && sortedItems.length === 0 ? (
            <p className="subtle-text">
              No notifications yet. Friend requests, quiz results, and challenge updates will appear here.
            </p>
          ) : null}

          <div className="app-notification-list">
            {sortedItems.map((notification) => {
              const meta = getMeta(notification.type);
              return (
                <article
                  key={notification.id}
                  className={`app-notification-item is-${meta.tone} ${
                    notification.is_read ? "" : "is-unread"
                  }`}
                >
                  <button
                    type="button"
                    className="app-notification-open"
                    onClick={() => void navigateFromNotification(notification)}
                  >
                    <span className="app-notification-icon">{meta.icon}</span>
                    <div className="app-notification-copy">
                      <div className="app-notification-title-row">
                        <strong>{notification.title}</strong>
                        <span>{formatRelativeTime(notification.created_at)}</span>
                      </div>
                      <p>{notification.message}</p>
                    </div>
                  </button>

                  <div className="app-notification-actions">
                    {!notification.is_read ? (
                      <button
                        type="button"
                        className="secondary-btn app-notification-mini-btn"
                        onClick={() => void handleMarkRead(notification.id)}
                        disabled={actionKey === `read-${notification.id}`}
                      >
                        Read
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="secondary-btn app-notification-mini-btn"
                      onClick={() => void handleDelete(notification.id)}
                      disabled={actionKey === `delete-${notification.id}`}
                    >
                      Remove
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default NotificationBell;
