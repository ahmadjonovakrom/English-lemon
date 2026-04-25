import { useEffect, useRef, useState } from "react";
import { createRoomSocket } from "../../api/rooms";

const RECONNECT_DELAY_MS = 2500;
const HEARTBEAT_MS = 20000;

export function useRoomSocket({ roomId, enabled = true, onMessage }) {
  const socketRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const onMessageRef = useRef(onMessage);
  const shouldReconnectRef = useRef(true);
  const [connectionState, setConnectionState] = useState("idle");
  const [socketError, setSocketError] = useState("");

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!roomId || !enabled) {
      setConnectionState("idle");
      return undefined;
    }

    shouldReconnectRef.current = true;

    const clearTimers = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    };

    const connect = () => {
      clearTimers();
      setConnectionState((previous) =>
        previous === "connected" || previous === "connecting" ? previous : "connecting"
      );

      const socket = createRoomSocket(roomId);
      if (!socket) {
        setConnectionState("error");
        setSocketError("Socket auth is unavailable.");
        return;
      }

      socketRef.current = socket;

      socket.onopen = () => {
        setConnectionState("connected");
        setSocketError("");
        socket.send(JSON.stringify({ type: "sync" }));
        heartbeatTimerRef.current = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "heartbeat" }));
          }
        }, HEARTBEAT_MS);
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          onMessageRef.current?.(payload);
        } catch {
          setSocketError("Received an invalid room socket payload.");
        }
      };

      socket.onerror = () => {
        setSocketError("Room connection failed.");
      };

      socket.onclose = () => {
        clearTimers();
        socketRef.current = null;
        if (!shouldReconnectRef.current) {
          setConnectionState("disconnected");
          return;
        }
        setConnectionState("reconnecting");
        reconnectTimerRef.current = setTimeout(() => {
          connect();
        }, RECONNECT_DELAY_MS);
      };
    };

    connect();

    return () => {
      shouldReconnectRef.current = false;
      clearTimers();
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [enabled, roomId]);

  const sendMessage = (payload) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      throw new Error("Room socket is not connected.");
    }
    socketRef.current.send(JSON.stringify(payload));
  };

  return {
    connectionState,
    socketError,
    sendMessage
  };
}
