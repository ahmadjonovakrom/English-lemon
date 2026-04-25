import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  acceptCall,
  acceptChallenge,
  acceptFriendRequest,
  activateCall,
  addCallCandidate,
  cancelCall,
  cancelChallenge,
  cancelFriendRequest,
  createNotificationsSocket,
  createPresenceSocket,
  createConversationChallenge,
  createOrGetDirectConversation,
  declineChallenge,
  declineCall,
  declineFriendRequest,
  endCall,
  getLatestConversationCall,
  listIncomingCalls,
  listConversationMessages,
  listConversations,
  listFriendRequests,
  listFriends,
  listNotifications,
  listPresence,
  markAllNotificationsRead,
  markConversationSeen,
  markNotificationRead,
  removeFriend,
  searchUsers,
  startConversationCall,
  sendConversationMessage,
  sendConversationVoiceMessage,
  sendFriendRequest
} from "../api/social";
import { toApiAssetUrl } from "../api/client";
import { useAuth } from "../context/AuthContext";
import "../features/social/social.css";

const SEARCH_MIN_CHARS = 1;
const POLLING_INTERVAL_MS = 8000;
const NOTIFICATION_SOCKET_HEARTBEAT_MS = 25000;
const NOTIFICATION_SOCKET_RECONNECT_MS = 3500;
const PRESENCE_SOCKET_HEARTBEAT_MS = 22000;
const PRESENCE_SOCKET_RECONNECT_MS = 3200;
const ACTIVITY_STALE_TIMEOUT_MS = 4500;
const TYPING_STOP_DELAY_MS = 1300;
const MESSAGES_LIMIT = 80;
const NOTIFICATIONS_LIMIT = 40;
const STATUS_NOTE_ERROR_PATTERN = /(unable|failed|error|unavailable|not found|cannot|forbidden|expired)/i;

const NOTIFICATION_TYPE_META = {
  new_message: { icon: "M", label: "Message", accent: "blue" },
  new_voice_message: { icon: "V", label: "Voice", accent: "yellow" },
  call_incoming: { icon: "C", label: "Call", accent: "green" },
  call_missed: { icon: "!", label: "Missed", accent: "red" },
  call_accepted: { icon: "C", label: "Call", accent: "green" },
  call_declined: { icon: "!", label: "Declined", accent: "red" },
  call_canceled: { icon: "C", label: "Call", accent: "red" },
  new_friend_request: { icon: "+", label: "Request", accent: "yellow" },
  friend_request_accepted: { icon: "✓", label: "Friend", accent: "green" },
  challenge_received: { icon: "Q", label: "Challenge", accent: "yellow" },
  challenge_accepted: { icon: "Q", label: "Challenge", accent: "green" },
  challenge_declined: { icon: "Q", label: "Challenge", accent: "red" }
};

const RELATIONSHIP_META = {
  friend: { label: "Friend", className: "is-friend" },
  incoming_request: { label: "Incoming", className: "is-incoming" },
  outgoing_request: { label: "Pending", className: "is-outgoing" },
  none: { label: "New", className: "is-default" }
};

const CHALLENGE_STATUS_META = {
  pending: { label: "Pending", className: "is-pending" },
  accepted: { label: "Accepted", className: "is-accepted" },
  declined: { label: "Declined", className: "is-declined" },
  canceled: { label: "Canceled", className: "is-canceled" },
  expired: { label: "Expired", className: "is-expired" },
  completed: { label: "Completed", className: "is-completed" }
};

const CHALLENGE_CATEGORY_OPTIONS = [
  "Vocabulary",
  "Grammar",
  "Idioms and Phrases",
  "Synonyms",
  "Collocations",
  "Mixed"
];

const CHALLENGE_DIFFICULTY_OPTIONS = ["Mixed", "Easy", "Intermediate", "Advanced"];

const CHALLENGE_EXPIRY_OPTIONS = [
  { label: "30 minutes", value: 30 },
  { label: "2 hours", value: 120 },
  { label: "24 hours", value: 1440 },
  { label: "3 days", value: 4320 }
];

const RECORDING_UPDATE_INTERVAL_MS = 200;
const MIN_VOICE_RECORDING_MS = 700;
const RECORDING_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4"
];
const VOICE_WAVEFORM_PATTERN = [
  24, 40, 30, 52, 38, 62, 34, 44, 28, 58, 36, 50, 32, 46, 34, 60, 38, 48, 30, 56, 35, 45, 28,
  42
];
const CALL_SIGNAL_POLLING_INTERVAL_MS = 1400;
const CALL_POLLING_LIMIT = 6;
const CALL_TERMINAL_STATUSES = new Set(["ended", "declined", "missed", "canceled"]);
const CALL_ACTIVE_STATUSES = new Set(["ringing", "connecting", "active"]);
const CALL_PHASES = new Set([
  "idle",
  "starting",
  "outgoing",
  "calling",
  "ringing",
  "incoming",
  "accepting",
  "connecting",
  "active",
  "connected",
  "reconnecting",
  "declined",
  "missed",
  "canceled",
  "ended",
  "failed"
]);
const CALL_TERMINAL_PHASES = new Set(["declined", "missed", "canceled", "ended", "failed"]);
const CALL_RECONNECT_TIMEOUT_MS = 9000;
const WEBRTC_DESCRIPTION_TYPES = new Set(["offer", "answer"]);
const RTC_CONFIGURATION = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }]
};

function toErrorMessage(error, fallback, { forSocialBootstrap = false } = {}) {
  const detail =
    typeof error?.detail === "string" && error.detail.trim()
      ? error.detail.trim()
      : typeof error?.data?.detail === "string" && error.data.detail.trim()
        ? error.data.detail.trim()
        : "";
  const message =
    typeof error?.message === "string" && error.message.trim() ? error.message.trim() : "";
  const normalized = (detail || message).trim().toLowerCase();
  const isNotFoundError =
    normalized === "not found" ||
    normalized === "notfound" ||
    normalized === "not found." ||
    /\b404\b/.test(normalized);

  if (forSocialBootstrap && isNotFoundError) {
    return "Social API routes are unavailable. Restart backend and refresh this page.";
  }
  if (isNotFoundError) {
    return fallback;
  }
  if (detail) {
    return detail;
  }
  if (message) {
    return message;
  }
  return fallback;
}

function formatDateLabel(value) {
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

function formatShortDate(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "--";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric"
  }).format(parsed);
}

function formatDateOnly(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "--";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: parsed.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined
  }).format(parsed);
}

function formatDurationLabel(value) {
  if (!Number.isFinite(value)) {
    return "0:00";
  }
  const safeSeconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeCallStatus(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!normalized) {
    return "ringing";
  }
  return normalized;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function getCallStatusLabel(status) {
  const normalized = normalizeCallStatus(status);
  if (normalized === "ringing") {
    return "Ringing";
  }
  if (normalized === "connecting") {
    return "Connecting";
  }
  if (normalized === "active") {
    return "Live";
  }
  if (normalized === "declined") {
    return "Declined";
  }
  if (normalized === "missed") {
    return "Missed";
  }
  if (normalized === "canceled") {
    return "Canceled";
  }
  if (normalized === "ended") {
    return "Ended";
  }
  return "Call";
}

function getNotificationTypeMeta(type) {
  return NOTIFICATION_TYPE_META[type] ?? { icon: "N", label: "Update", accent: "blue" };
}

function candidateSignature(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return "";
  }
  const candidateText =
    typeof candidate.candidate === "string" ? candidate.candidate : JSON.stringify(candidate);
  const sdpMid = typeof candidate.sdpMid === "string" ? candidate.sdpMid : "";
  const sdpMLineIndex =
    Number.isFinite(candidate.sdpMLineIndex) || typeof candidate.sdpMLineIndex === "number"
      ? String(candidate.sdpMLineIndex)
      : "";
  return `${candidateText}|${sdpMid}|${sdpMLineIndex}`;
}

function logVoiceCallError(scope, error, extra = {}) {
  const payload = {
    scope,
    name: error?.name ?? null,
    message: error?.message ?? null,
    detail: typeof error?.detail === "string" ? error.detail : null,
    status: Number.isFinite(error?.status) ? error.status : null,
    data: error?.data ?? null,
    ...extra
  };
  console.error("[VoiceCall]", payload);
}

function signalingSdpPreview(value, maxLines = 4, maxChars = 260) {
  const lines = String(value || "")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const preview = lines.slice(0, maxLines).join(" | ");
  if (preview.length > maxChars) {
    return `${preview.slice(0, maxChars)}...`;
  }
  return preview;
}

function normalizeSessionDescriptionInput(rawValue, expectedType, contextLabel) {
  let declaredType = "";
  let sdpValue = "";

  if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
    if (typeof rawValue.type === "string") {
      declaredType = rawValue.type.trim().toLowerCase();
    }
    if (declaredType === "candidate" || hasOwn(rawValue, "candidate")) {
      throw new Error(`${contextLabel} is an ICE candidate, not a WebRTC session description.`);
    }
    if (typeof rawValue.sdp === "string") {
      sdpValue = rawValue.sdp;
    } else if (
      rawValue.sdp &&
      typeof rawValue.sdp === "object" &&
      !Array.isArray(rawValue.sdp)
    ) {
      if (typeof rawValue.sdp.type === "string" && !declaredType) {
        declaredType = rawValue.sdp.type.trim().toLowerCase();
      }
      if (typeof rawValue.sdp.sdp === "string") {
        sdpValue = rawValue.sdp.sdp;
      }
    }
  } else if (typeof rawValue === "string") {
    const trimmed = rawValue.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          if (typeof parsed.type === "string") {
            declaredType = parsed.type.trim().toLowerCase();
          }
          if (declaredType === "candidate" || hasOwn(parsed, "candidate")) {
            throw new Error(`${contextLabel} is an ICE candidate, not a WebRTC session description.`);
          }
          if (typeof parsed.sdp === "string") {
            sdpValue = parsed.sdp;
          } else if (
            parsed.sdp &&
            typeof parsed.sdp === "object" &&
            !Array.isArray(parsed.sdp)
          ) {
            if (typeof parsed.sdp.type === "string" && !declaredType) {
              declaredType = parsed.sdp.type.trim().toLowerCase();
            }
            if (typeof parsed.sdp.sdp === "string") {
              sdpValue = parsed.sdp.sdp;
            }
          } else {
            sdpValue = rawValue;
          }
        } else {
          sdpValue = rawValue;
        }
      } catch {
        sdpValue = rawValue;
      }
    } else {
      sdpValue = rawValue;
    }
  }

  if (!WEBRTC_DESCRIPTION_TYPES.has(expectedType)) {
    throw new Error(`${contextLabel} expected type is invalid.`);
  }
  if (declaredType && !WEBRTC_DESCRIPTION_TYPES.has(declaredType)) {
    throw new Error(`${contextLabel} has invalid signaling type "${declaredType}".`);
  }
  if (declaredType && declaredType !== expectedType) {
    throw new Error(`${contextLabel} has invalid SDP type "${declaredType}".`);
  }

  let normalizedSdp = String(sdpValue || "");
  if (
    normalizedSdp.includes("\\r\\n") &&
    !normalizedSdp.includes("\n") &&
    !normalizedSdp.includes("\r")
  ) {
    normalizedSdp = normalizedSdp.replace(/\\r\\n/g, "\r\n");
  } else if (normalizedSdp.includes("\\n") && !normalizedSdp.includes("\n")) {
    normalizedSdp = normalizedSdp.replace(/\\n/g, "\n");
  }
  normalizedSdp = normalizedSdp.trim();

  if (!normalizedSdp) {
    throw new Error(`${contextLabel} is missing SDP.`);
  }

  const lines = normalizedSdp
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 5) {
    throw new Error(`${contextLabel} is incomplete.`);
  }
  if (
    lines[0].startsWith("a=") ||
    lines[0].startsWith("candidate:") ||
    lines[0].startsWith("a=candidate:")
  ) {
    throw new Error(`${contextLabel} is not a complete SDP offer/answer.`);
  }
  if (!lines.length || !lines[0].startsWith("v=0")) {
    throw new Error(`${contextLabel} is malformed: first SDP line must start with v=.`);
  }
  if (!lines.some((line) => line.startsWith("o="))) {
    throw new Error(`${contextLabel} is malformed: missing origin line.`);
  }
  if (!lines.some((line) => line.startsWith("s="))) {
    throw new Error(`${contextLabel} is malformed: missing session line.`);
  }
  if (!lines.some((line) => line.startsWith("t="))) {
    throw new Error(`${contextLabel} is malformed: missing timing line.`);
  }
  if (!lines.some((line) => line.startsWith("m="))) {
    throw new Error(`${contextLabel} is malformed: missing media line.`);
  }
  if (lines[0].startsWith("candidate:") || lines[0].startsWith("a=candidate:")) {
    throw new Error(`${contextLabel} looks like an ICE candidate, not an SDP description.`);
  }
  if (lines.some((line) => !line || !/^[a-z]=/.test(line))) {
    throw new Error(`${contextLabel} contains invalid SDP lines.`);
  }

  return {
    type: expectedType,
    sdp: normalizedSdp
  };
}

function normalizeIceCandidateInput(rawValue, contextLabel) {
  const candidatePayload =
    rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
      ? rawValue.type === "candidate" && rawValue.candidate && typeof rawValue.candidate === "object"
        ? rawValue.candidate
        : rawValue
      : null;

  if (!candidatePayload || typeof candidatePayload !== "object") {
    throw new Error(`${contextLabel} is missing ICE candidate data.`);
  }
  if (typeof candidatePayload.sdp === "string" || ["offer", "answer"].includes(candidatePayload.type)) {
    throw new Error(`${contextLabel} contains SDP where an ICE candidate was expected.`);
  }
  const candidateText =
    typeof candidatePayload.candidate === "string" ? candidatePayload.candidate.trim() : "";
  if (!candidateText) {
    throw new Error(`${contextLabel} is missing the candidate line.`);
  }
  if (candidateText.startsWith("v=0") || candidateText.includes("\nm=") || candidateText.includes("\r\nm=")) {
    throw new Error(`${contextLabel} contains a session description, not an ICE candidate.`);
  }
  return {
    candidate: candidateText,
    sdpMid:
      typeof candidatePayload.sdpMid === "string" || candidatePayload.sdpMid === null
        ? candidatePayload.sdpMid
        : undefined,
    sdpMLineIndex:
      Number.isInteger(candidatePayload.sdpMLineIndex)
        ? candidatePayload.sdpMLineIndex
        : undefined,
    usernameFragment:
      typeof candidatePayload.usernameFragment === "string"
        ? candidatePayload.usernameFragment
        : undefined
  };
}

function readRawSdp(value) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object" && typeof value.sdp === "string") {
    return value.sdp;
  }
  if (
    typeof value === "object" &&
    value.sdp &&
    typeof value.sdp === "object" &&
    typeof value.sdp.sdp === "string"
  ) {
    return value.sdp.sdp;
  }
  return "";
}

function logSignalingPayload(label, payload, extra = {}) {
  const sdp = typeof payload?.sdp === "string" ? payload.sdp : "";
  console.info(`[VoiceCall] ${label}`, {
    type: payload?.type ?? null,
    sdpLength: sdp.length,
    sdpPreview: signalingSdpPreview(sdp),
    ...extra
  });
}

function formatSdpForWebRtc(sdp) {
  const normalized = String(sdp || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return `${normalized.replace(/\n/g, "\r\n").replace(/\r\n+$/, "")}\r\n`;
}

function removeLegacySsrcLines(sdp) {
  return formatSdpForWebRtc(
    String(sdp || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .filter((line) => !line.trim().startsWith("a=ssrc:"))
      .join("\n")
  );
}

async function applyRemoteDescriptionWithSdpFallback(peer, description, label) {
  const remoteDescription = {
    type: description.type,
    sdp: formatSdpForWebRtc(description.sdp)
  };

  console.log("REMOTE DESC:", remoteDescription);
  console.log("TYPE:", remoteDescription?.type);
  console.log("SDP START:", remoteDescription?.sdp?.slice(0, 150));
  console.info("[VoiceCall] setRemoteDescription payload", {
    label,
    type: remoteDescription.type,
    sdpLength: remoteDescription.sdp.length,
    sdpStart: remoteDescription.sdp.slice(0, 150),
    startsWithV0: remoteDescription.sdp.startsWith("v=0")
  });

  if (!["offer", "answer"].includes(remoteDescription.type) || !remoteDescription.sdp.startsWith("v=0")) {
    throw new Error(`${label} is not a full WebRTC session description.`);
  }

  try {
    await peer.setRemoteDescription(new RTCSessionDescription(remoteDescription));
    return remoteDescription;
  } catch (error) {
    const message = typeof error?.message === "string" ? error.message : "";
    if (!/Invalid SDP line/i.test(message) || !remoteDescription.sdp.includes("\r\na=ssrc:")) {
      throw error;
    }

    const repairedDescription = {
      ...remoteDescription,
      sdp: removeLegacySsrcLines(remoteDescription.sdp)
    };
    console.warn("[VoiceCall] retrying setRemoteDescription without legacy a=ssrc lines", {
      label,
      originalLength: remoteDescription.sdp.length,
      repairedLength: repairedDescription.sdp.length,
      repairedStart: repairedDescription.sdp.slice(0, 150)
    });
    await peer.setRemoteDescription(new RTCSessionDescription(repairedDescription));
    return repairedDescription;
  }
}

function resolveRecorderMimeType() {
  if (typeof window === "undefined" || typeof window.MediaRecorder === "undefined") {
    return "";
  }
  const supported = RECORDING_MIME_CANDIDATES.find((candidate) =>
    window.MediaRecorder.isTypeSupported(candidate)
  );
  return supported ?? "";
}

function getMicrophoneErrorMessage(error) {
  const errorName = typeof error?.name === "string" ? error.name : "";
  if (errorName === "NotAllowedError" || errorName === "SecurityError") {
    return "Microphone permission was denied.";
  }
  if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
    return "No microphone was found on this device.";
  }
  if (errorName === "NotReadableError" || errorName === "TrackStartError") {
    return "Microphone is busy. Close other apps using it and try again.";
  }
  if (errorName === "AbortError") {
    return "Recording was interrupted. Please try again.";
  }
  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  return "Unable to access microphone.";
}

function IconMic() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Zm-6 8a1 1 0 1 1 2 0 4 4 0 0 0 8 0 1 1 0 1 1 2 0 6 6 0 0 1-5 5.91V20h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-3.09A6 6 0 0 1 6 11Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m8 5 11 7-11 7V5Z" fill="currentColor" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5h3v14H8V5Zm5 0h3v14h-3V5Z" fill="currentColor" />
    </svg>
  );
}

function IconSend() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 11.6c0-.7.45-1.32 1.11-1.54L19.7 4.8c1.41-.47 2.73.85 2.26 2.26l-5.26 15.58c-.22.66-.84 1.11-1.54 1.11a1.62 1.62 0 0 1-1.5-1l-2.27-5.67a1 1 0 0 0-.56-.56l-5.67-2.27A1.62 1.62 0 0 1 3 11.6Zm3.5.25 4.88 1.95c.49.2.88.59 1.08 1.08l1.95 4.88L19.6 6.66 6.5 11.85Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6.7 5.3a1 1 0 0 1 1.4 0L12 9.17l3.9-3.88a1 1 0 1 1 1.4 1.42L13.42 10.6l3.88 3.9a1 1 0 1 1-1.42 1.4L12 12.02l-3.9 3.88a1 1 0 1 1-1.4-1.42l3.88-3.9-3.88-3.9a1 1 0 0 1 0-1.4Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconPhone() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6.77 4.93a2 2 0 0 1 2.74-.13l1.66 1.42a2 2 0 0 1 .57 2.27l-.57 1.6a1 1 0 0 0 .22 1.04l1.28 1.28a1 1 0 0 0 1.04.22l1.6-.57a2 2 0 0 1 2.27.57l1.42 1.66a2 2 0 0 1-.13 2.74l-.96.96a3 3 0 0 1-2.76.82c-2.44-.53-4.81-1.8-7.12-4.11-2.31-2.31-3.58-4.68-4.11-7.12a3 3 0 0 1 .82-2.76l.96-.96Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconPhoneOff() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M21.8 14.54c.25.37.22.87-.08 1.2l-1.45 1.56a3.4 3.4 0 0 1-3.1 1.03c-2.53-.43-5.01-1.63-7.46-4.08-2.46-2.45-3.66-4.93-4.08-7.46A3.4 3.4 0 0 1 6.56 3.7l1.56-1.45a1 1 0 0 1 1.2-.08l2.6 1.7c.41.27.59.78.44 1.25l-.7 2.12a1 1 0 0 0 .25 1.01l3.08 3.08a1 1 0 0 0 1.01.25l2.12-.7a1 1 0 0 1 1.25.44l1.7 2.6Z"
        fill="currentColor"
      />
      <path d="m4 4 16 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconVolumeOn() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12.8 4.7a1 1 0 0 1 1.7.7v13.2a1 1 0 0 1-1.7.7L8.9 15H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3.9l3.9-4.3Zm4.66 2.64a1 1 0 0 1 1.4-.08A7 7 0 0 1 19 17.08a1 1 0 1 1-1.52-1.3 5 5 0 0 0-.1-7.04 1 1 0 0 1 .08-1.4Zm-2.35 2.18a1 1 0 0 1 1.41-.04A3.49 3.49 0 0 1 17 11.99c0 .96-.39 1.88-1.08 2.54a1 1 0 0 1-1.38-1.44c.29-.28.46-.66.46-1.1a1.5 1.5 0 0 0-.48-1.1 1 1 0 0 1-.04-1.41Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconVolumeOff() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12.8 4.7a1 1 0 0 1 1.7.7v13.2a1 1 0 0 1-1.7.7L8.9 15H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3.9l3.9-4.3Z"
        fill="currentColor"
      />
      <path d="m17 9 4 4m0-4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconMicMuted() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3a3 3 0 0 1 3 3v4.4l-6-6A3 3 0 0 1 12 3Zm6 8a1 1 0 1 1 2 0c0 2.32-1.32 4.33-3.25 5.33L18 17.58V20h2a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h2v-2.42L3.7 11.3a1 1 0 0 1 1.4-1.42l14.6 14.6a1 1 0 1 1-1.4 1.42l-2.68-2.68A6.97 6.97 0 0 1 12 18a7 7 0 0 1-7-7 1 1 0 0 1 2 0 5 5 0 0 0 5 5c.82 0 1.6-.2 2.29-.56L13 14.15V11L8.28 6.28A2.98 2.98 0 0 0 9 8v3a3 3 0 0 0 .88 2.12l-1.41 1.41A5 5 0 0 1 7 11V8.83l-2-2V4.5a1 1 0 0 1 1.7-.7l2.59 2.59Z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconMicLive() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 3a3 3 0 0 1 3 3v5a3 3 0 1 1-6 0V6a3 3 0 0 1 3-3Zm-6 8a1 1 0 1 1 2 0 4 4 0 0 0 8 0 1 1 0 1 1 2 0 6 6 0 0 1-5 5.91V20h2a1 1 0 1 1 0 2H9a1 1 0 1 1 0-2h2v-3.09A6 6 0 0 1 6 11Z"
        fill="currentColor"
      />
    </svg>
  );
}

function VoiceMessagePlayer({
  playerId,
  src,
  durationSeconds,
  tone = "peer",
  compact = false
}) {
  const audioRef = useRef(null);
  const frameRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPendingPlay, setIsPendingPlay] = useState(false);
  const [duration, setDuration] = useState(
    Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0
  );
  const [currentTime, setCurrentTime] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const isSeekingRef = useRef(false);
  const [seekValue, setSeekValue] = useState(0);
  const [isLoadingAudio, setIsLoadingAudio] = useState(Boolean(src));
  const [isReady, setIsReady] = useState(false);
  const [hasPlaybackError, setHasPlaybackError] = useState(false);
  const isUnavailable = !src || hasPlaybackError;

  useEffect(() => {
    setDuration(Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0);
  }, [durationSeconds]);

  useEffect(() => {
    isSeekingRef.current = isSeeking;
  }, [isSeeking]);

  useEffect(() => {
    setCurrentTime(0);
    setSeekValue(0);
    setIsSeeking(false);
    isSeekingRef.current = false;
    setIsPlaying(false);
    setIsPendingPlay(false);
    setHasPlaybackError(false);
    setIsReady(false);
    setIsLoadingAudio(Boolean(src));
  }, [src, playerId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return undefined;
    }

    const clearFrame = () => {
      if (frameRef.current) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
    };

    const tick = () => {
      if (!audio.paused && !audio.ended) {
        if (!isSeekingRef.current) {
          setCurrentTime(audio.currentTime || 0);
        }
        frameRef.current = window.requestAnimationFrame(tick);
      } else {
        frameRef.current = 0;
      }
    };

    const startTicker = () => {
      clearFrame();
      frameRef.current = window.requestAnimationFrame(tick);
    };

    const handleLoadStart = () => {
      setIsLoadingAudio(true);
      setHasPlaybackError(false);
    };
    const handleLoadedMetadata = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
    };
    const handleCanPlay = () => {
      setIsReady(true);
      setIsLoadingAudio(false);
    };
    const handleTimeUpdate = () => {
      if (!isSeekingRef.current) {
        setCurrentTime(audio.currentTime || 0);
      }
    };
    const handleWaiting = () => {
      if (!audio.paused) {
        setIsLoadingAudio(true);
      }
    };
    const handlePlaying = () => {
      setIsPlaying(true);
      setIsPendingPlay(false);
      setIsLoadingAudio(false);
      startTicker();
    };
    const handlePause = () => {
      setIsPlaying(false);
      setIsPendingPlay(false);
      clearFrame();
    };
    const handleEnded = () => {
      setIsPlaying(false);
      setIsPendingPlay(false);
      setCurrentTime(0);
      setSeekValue(0);
      audio.currentTime = 0;
      clearFrame();
    };
    const handleError = () => {
      setHasPlaybackError(true);
      setIsPendingPlay(false);
      setIsPlaying(false);
      setIsLoadingAudio(false);
      clearFrame();
    };

    audio.addEventListener("loadstart", handleLoadStart);
    audio.addEventListener("loadedmetadata", handleLoadedMetadata);
    audio.addEventListener("canplay", handleCanPlay);
    audio.addEventListener("waiting", handleWaiting);
    audio.addEventListener("stalled", handleWaiting);
    audio.addEventListener("playing", handlePlaying);
    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);

    return () => {
      audio.pause();
      clearFrame();
      audio.removeEventListener("loadstart", handleLoadStart);
      audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audio.removeEventListener("canplay", handleCanPlay);
      audio.removeEventListener("waiting", handleWaiting);
      audio.removeEventListener("stalled", handleWaiting);
      audio.removeEventListener("playing", handlePlaying);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
    };
  }, [src, playerId]);

  const safeDuration =
    Number.isFinite(duration) && duration > 0
      ? duration
      : Number.isFinite(durationSeconds) && durationSeconds > 0
        ? durationSeconds
        : 0;
  const visualCurrentTime = isSeeking ? seekValue : currentTime;
  const boundedCurrentTime = clamp(
    Number.isFinite(visualCurrentTime) ? visualCurrentTime : 0,
    0,
    safeDuration > 0 ? safeDuration : 1
  );
  const progressPercent =
    safeDuration > 0 ? clamp((boundedCurrentTime / safeDuration) * 100, 0, 100) : 0;
  const filledWaveBars = Math.max(
    0,
    Math.min(
      VOICE_WAVEFORM_PATTERN.length,
      Math.round((progressPercent / 100) * VOICE_WAVEFORM_PATTERN.length)
    )
  );
  const playbackStatusLabel = hasPlaybackError
    ? "Unavailable"
    : isPendingPlay || (isLoadingAudio && !isReady)
      ? "Loading..."
      : isPlaying
        ? "Playing"
        : "Voice";

  const handleSeekChange = (value) => {
    const audio = audioRef.current;
    if (!audio || safeDuration <= 0 || hasPlaybackError) {
      return;
    }
    const nextTime = clamp(Number(value), 0, safeDuration);
    setIsSeeking(true);
    isSeekingRef.current = true;
    setSeekValue(nextTime);
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  const commitSeek = () => {
    const audio = audioRef.current;
    if (!audio || safeDuration <= 0 || hasPlaybackError) {
      setIsSeeking(false);
      isSeekingRef.current = false;
      return;
    }
    const activeValue = Number.isFinite(seekValue) ? seekValue : currentTime;
    const nextTime = clamp(Number(activeValue), 0, safeDuration);
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
    setSeekValue(nextTime);
    setIsSeeking(false);
    isSeekingRef.current = false;
  };

  const togglePlayback = async () => {
    const audio = audioRef.current;
    if (!audio || !src || hasPlaybackError) {
      return;
    }
    if (audio.paused) {
      document.querySelectorAll("audio[data-social-voice='true']").forEach((element) => {
        if (element !== audio) {
          element.pause();
        }
      });
      setIsPendingPlay(true);
      try {
        await audio.play();
      } catch (error) {
        console.warn("[VoiceMessage] playback failed", {
          playerId,
          message: error?.message ?? "Unable to play audio"
        });
        setIsPendingPlay(false);
        setIsPlaying(false);
        if (error?.name !== "AbortError") {
          setHasPlaybackError(true);
        }
      }
      return;
    }
    audio.pause();
  };

  return (
    <div
      className={`social-voice-player-shell ${compact ? "is-compact" : ""} ${
        isPlaying || isPendingPlay ? "is-playing" : ""
      } ${tone === "mine" ? "is-mine" : "is-peer"} ${isUnavailable ? "is-error" : ""}`}
    >
      <audio
        ref={audioRef}
        data-social-voice="true"
        preload="auto"
        src={src}
        className="social-voice-player-audio"
      />

      <button
        type="button"
        className="social-voice-play-btn"
        onClick={togglePlayback}
        disabled={isUnavailable}
        aria-label={isPlaying ? "Pause voice message" : "Play voice message"}
        title={isPlaying ? "Pause" : "Play"}
      >
        <span className="social-voice-play-ripple" aria-hidden="true" />
        {isPlaying ? <IconPause /> : <IconPlay />}
      </button>

      <div className="social-voice-track">
        <div className="social-voice-meta-row">
          <span className="social-voice-label">Voice</span>
          <span className="social-voice-status">{playbackStatusLabel}</span>
        </div>
        <div className="social-voice-track-shell">
          <div className="social-voice-waveform" aria-hidden="true">
            {VOICE_WAVEFORM_PATTERN.map((height, index) => (
              <span
                key={`${playerId}-wave-${index}`}
                className={index < filledWaveBars ? "is-filled" : ""}
                style={{ "--voice-wave-height": `${height}%` }}
              />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={safeDuration > 0 ? safeDuration : 1}
            step={0.05}
            value={boundedCurrentTime}
            onChange={(event) => handleSeekChange(event.target.value)}
            onMouseUp={commitSeek}
            onTouchEnd={commitSeek}
            onKeyUp={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                commitSeek();
              }
            }}
            onBlur={commitSeek}
            className="social-voice-progress"
            style={{ "--voice-progress": `${progressPercent}%` }}
            aria-label="Voice message progress"
            aria-valuemin={0}
            aria-valuemax={Math.round(safeDuration)}
            aria-valuenow={Math.round(boundedCurrentTime)}
            aria-valuetext={`${formatDurationLabel(boundedCurrentTime)} of ${formatDurationLabel(
              safeDuration
            )}`}
          />
        </div>
        <div className="social-voice-time-row">
          <span>{formatDurationLabel(boundedCurrentTime)}</span>
          <span>{formatDurationLabel(safeDuration || durationSeconds || 0)}</span>
        </div>
      </div>
    </div>
  );
}

function formatRelativeTime(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "Now";
  }

  const diffMs = parsed.getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  if (absMs < 60_000) {
    return formatter.format(Math.round(diffMs / 1000), "second");
  }
  if (absMs < 3_600_000) {
    return formatter.format(Math.round(diffMs / 60_000), "minute");
  }
  if (absMs < 86_400_000) {
    return formatter.format(Math.round(diffMs / 3_600_000), "hour");
  }
  return formatter.format(Math.round(diffMs / 86_400_000), "day");
}

function formatPresenceLabel(presence) {
  if (presence?.in_call) {
    return "in call";
  }
  if (presence?.is_online) {
    return "online";
  }
  const lastSeen = presence?.last_seen;
  if (!lastSeen) {
    return "offline";
  }
  const parsed = new Date(lastSeen);
  if (Number.isNaN(parsed.getTime())) {
    return "offline";
  }
  const now = new Date();
  const diffMs = now.getTime() - parsed.getTime();
  if (diffMs < 60_000) {
    return "last seen just now";
  }
  if (diffMs < 60 * 60_000) {
    return `last seen ${Math.max(1, Math.round(diffMs / 60_000))} minutes ago`;
  }
  if (parsed.toDateString() === now.toDateString()) {
    return `last seen today at ${parsed.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit"
    })}`;
  }
  return `last seen ${formatDateOnly(lastSeen)}`;
}

function initialsForUser(user) {
  const source =
    typeof user?.display_name === "string" && user.display_name.trim()
      ? user.display_name
      : typeof user?.username === "string" && user.username.trim()
        ? user.username
        : "EL";

  return source
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((chunk) => chunk[0]?.toUpperCase() ?? "")
    .join("");
}

function displayNameForUser(user, fallback = "English Lemon Player") {
  return user?.display_name || user?.username || fallback;
}

function usernameForUser(user) {
  return user?.username ? `@${user.username}` : "@player";
}

function identityLineForUser(user) {
  if (typeof user?.email === "string" && user.email.trim()) {
    return user.email.trim();
  }
  return usernameForUser(user);
}

function SocialSectionSkeleton({ rows = 3 }) {
  return (
    <div className="social-state-stack" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="social-skeleton-card">
          <span className="social-skeleton-avatar" />
          <div className="social-skeleton-lines">
            <span className="social-skeleton-line is-title" />
            <span className="social-skeleton-line" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SocialSectionState({
  badge,
  title,
  description,
  actionLabel,
  onAction,
  actionDisabled = false
}) {
  return (
    <div className="social-empty-card">
      {badge ? <span className="social-empty-badge">{badge}</span> : null}
      <h3>{title}</h3>
      <p className="subtle-text">{description}</p>
      {actionLabel && onAction ? (
        <button
          type="button"
          className="secondary-btn social-empty-action"
          onClick={onAction}
          disabled={actionDisabled}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

function resolveCallPhaseCopy(phase, callStatus, peerName) {
  const displayName = peerName || "Player";
  if (phase === "outgoing") {
    return `Calling ${displayName}...`;
  }
  if (phase === "starting") {
    return `Starting secure call with ${displayName}...`;
  }
  if (phase === "incoming") {
    return "Incoming voice call";
  }
  if (phase === "accepting") {
    return "Joining call...";
  }
  if (phase === "ringing" || phase === "calling") {
    return "Ringing...";
  }
  if (phase === "connecting") {
    return "Connecting call...";
  }
  if (phase === "active") {
    return "Voice call active";
  }
  if (phase === "connected") {
    return "Connected";
  }
  if (phase === "reconnecting") {
    return "Reconnecting...";
  }
  if (phase === "declined") {
    return "Call declined";
  }
  if (phase === "missed") {
    return "Missed call";
  }
  if (phase === "canceled") {
    return "Call canceled";
  }
  if (phase === "ended") {
    return "Call ended";
  }
  if (phase === "failed") {
    return "Call failed";
  }
  return getCallStatusLabel(callStatus);
}

function getCallPhaseTone(phase) {
  if (["connected", "active"].includes(phase)) {
    return "LIVE";
  }
  if (phase === "reconnecting") {
    return "RECONNECTING";
  }
  if (["incoming", "ringing", "calling", "outgoing"].includes(phase)) {
    return "RINGING";
  }
  if (["starting", "accepting", "connecting"].includes(phase)) {
    return "CONNECTING";
  }
  if (phase === "missed") {
    return "MISSED";
  }
  if (CALL_TERMINAL_PHASES.has(phase)) {
    return "CLOSED";
  }
  return "READY";
}

function getCallPhaseMeta(phase, callStatus) {
  const normalizedStatus = normalizeCallStatus(callStatus);
  if (["connected", "active"].includes(phase)) {
    return { tone: "live", label: "Secure voice link", helper: "Audio connected" };
  }
  if (phase === "reconnecting") {
    return { tone: "warning", label: "Connection recovering", helper: "Keeping the room open" };
  }
  if (phase === "incoming") {
    return { tone: "ringing", label: "Incoming", helper: "Answer when you are ready" };
  }
  if (phase === "accepting") {
    return { tone: "connecting", label: "Joining", helper: "Preparing microphone" };
  }
  if (["starting", "outgoing", "calling", "ringing"].includes(phase)) {
    return { tone: "ringing", label: "Ringing", helper: "Waiting for response" };
  }
  if (phase === "connecting") {
    return { tone: "connecting", label: "Connecting", helper: "Negotiating audio" };
  }
  if (phase === "declined") {
    return { tone: "closed", label: "Declined", helper: "The call was declined" };
  }
  if (phase === "missed") {
    return { tone: "closed", label: "Missed", helper: "No answer this time" };
  }
  if (phase === "failed") {
    return { tone: "danger", label: "Failed", helper: "Connection could not be completed" };
  }
  if (phase === "canceled") {
    return { tone: "closed", label: "Canceled", helper: "Call was canceled" };
  }
  if (phase === "ended") {
    return { tone: "closed", label: "Ended", helper: "Call finished" };
  }
  return { tone: "idle", label: getCallPhaseTone(phase), helper: getCallStatusLabel(normalizedStatus) };
}

function CallOverlay({
  visible,
  phase,
  call,
  peer,
  durationSeconds,
  callError,
  isMuted,
  isSpeakerOn,
  isActionLoading,
  onAccept,
  onDecline,
  onCancel,
  onEnd,
  onToggleMute,
  onToggleSpeaker
}) {
  if (!visible) {
    return null;
  }

  const peerName = peer?.display_name || peer?.username || "English Lemon Player";
  const isIncoming = phase === "incoming" || phase === "accepting";
  const isTerminal = CALL_TERMINAL_PHASES.has(phase);
  const showLiveControls = ["active", "connected", "reconnecting"].includes(phase);
  const showPendingControls = [
    "starting",
    "outgoing",
    "calling",
    "ringing",
    "connecting",
    "incoming",
    "accepting"
  ].includes(phase);
  const callStatus = normalizeCallStatus(call?.status);
  const statusCopy = resolveCallPhaseCopy(phase, callStatus, peerName);
  const phaseMeta = getCallPhaseMeta(phase, callStatus);
  const isAcceptDisabled = isActionLoading || phase === "accepting";

  return (
    <div className={`social-call-overlay is-${phase}`} role="dialog" aria-modal="true">
      <div className="social-call-backdrop" />
      <section className="social-call-panel">
        <div className="social-call-glow" aria-hidden="true" />
        <div className="social-call-topline">
          <span className={`social-call-state-chip is-${phaseMeta.tone}`}>
            {phaseMeta.label}
          </span>
          <span>{getCallPhaseTone(phase)}</span>
        </div>
        <div className="social-call-avatar-wrap">
          <span className="social-call-avatar">{initialsForUser(peer)}</span>
          <span className={`social-call-ping ${showLiveControls ? "is-live" : ""}`} />
        </div>

        <div className="social-call-copy">
          <p className="brand-mark">English Lemon</p>
          <h2>{peerName}</h2>
          <p className="social-call-status">{statusCopy}</p>
          <p className="social-call-meta">
            {showLiveControls
              ? `${formatDurationLabel(durationSeconds)} · ${phaseMeta.helper}`
              : phaseMeta.helper}
          </p>
        </div>

        <div
          className={`social-call-signal ${showLiveControls ? "is-live" : ""}`}
          aria-hidden="true"
        >
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>

        {callError ? <p className="error-text social-call-error">{callError}</p> : null}

        {showLiveControls ? (
          <div className="social-call-controls">
            <button
              type="button"
              className={`social-call-control-btn ${isMuted ? "is-muted" : "is-primary"}`}
              onClick={onToggleMute}
              disabled={isActionLoading}
              aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
              title={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted ? <IconMicMuted /> : <IconMicLive />}
              <span>{isMuted ? "Muted" : "Mic On"}</span>
            </button>
            <button
              type="button"
              className={`social-call-control-btn ${isSpeakerOn ? "is-primary" : "is-muted"}`}
              onClick={onToggleSpeaker}
              disabled={isActionLoading}
              aria-label={isSpeakerOn ? "Turn speaker off" : "Turn speaker on"}
              title={isSpeakerOn ? "Speaker on" : "Speaker off"}
            >
              {isSpeakerOn ? <IconVolumeOn /> : <IconVolumeOff />}
              <span>{isSpeakerOn ? "Speaker" : "Quiet"}</span>
            </button>
            <button
              type="button"
              className="social-call-control-btn is-danger"
              onClick={onEnd}
              disabled={isActionLoading}
              aria-label="End call"
              title="End call"
            >
              <IconPhoneOff />
              <span>{isActionLoading ? "Ending..." : "End"}</span>
            </button>
          </div>
        ) : null}

        {showPendingControls ? (
          <div className={`social-call-pending-actions ${isIncoming ? "is-incoming" : ""}`}>
            {isIncoming ? (
              <>
                <button
                  type="button"
                  className="social-call-control-btn is-accept"
                  onClick={onAccept}
                  disabled={isAcceptDisabled}
                >
                  <IconPhone />
                  <span>{phase === "accepting" ? "Joining..." : "Accept"}</span>
                </button>
                <button
                  type="button"
                  className="social-call-control-btn is-danger"
                  onClick={onDecline}
                  disabled={isActionLoading}
                >
                  <IconPhoneOff />
                  <span>{isActionLoading ? "Declining..." : "Decline"}</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="social-call-control-btn is-danger"
                onClick={onCancel}
                disabled={isActionLoading}
              >
                <IconPhoneOff />
                <span>{isActionLoading ? "Canceling..." : "End"}</span>
              </button>
            )}
          </div>
        ) : null}

        {isTerminal ? (
          <div className="social-call-terminal-note">
            <span>{statusCopy}</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function getChallengeStatusMeta(challenge) {
  const statusKey =
    challenge?.is_expired && challenge?.status === "pending"
      ? "expired"
      : challenge?.status ?? "pending";
  return CHALLENGE_STATUS_META[statusKey] ?? CHALLENGE_STATUS_META.pending;
}

function mapMessageTimelineFallback(messages) {
  return messages.map((message) => ({
    id: `message-${message.id}`,
    kind:
      message.kind === "voice" ? "voice" : message.kind === "call_event" ? "call_event" : "message",
    created_at: message.created_at,
    message
  }));
}

function SocialPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const messageListRef = useRef(null);
  const notificationsPanelRef = useRef(null);
  const notificationSocketRef = useRef(null);
  const notificationReconnectTimerRef = useRef(0);
  const notificationHeartbeatTimerRef = useRef(0);
  const presenceSocketRef = useRef(null);
  const presenceReconnectTimerRef = useRef(0);
  const presenceHeartbeatTimerRef = useRef(0);
  const typingStopTimerRef = useRef(0);
  const typingConversationIdRef = useRef(null);
  const activityTimersRef = useRef({});
  const isTypingSentRef = useRef(false);
  const activeCallLiveRef = useRef(false);
  const selectedConversationIdRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordingStreamRef = useRef(null);
  const recordingChunksRef = useRef([]);
  const recordingStartRef = useRef(0);
  const recordingIntervalRef = useRef(null);
  const discardRecordingRef = useRef(false);
  const sendRecordingOnStopRef = useRef(false);
  const remoteAudioRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localCallStreamRef = useRef(null);
  const remoteCallStreamRef = useRef(null);
  const callIdRef = useRef(null);
  const pendingLocalCandidatesRef = useRef([]);
  const pendingIceCandidatesRef = useRef([]);
  const remoteCandidateSignaturesRef = useRef(new Set());
  const remoteDescriptionSignatureRef = useRef("");
  const activationRequestRef = useRef(false);
  const previousCallStatusRef = useRef("");
  const callPhaseRef = useRef("idle");
  const activeCallRef = useRef(null);
  const incomingCallRef = useRef(null);
  const callActionLockRef = useRef(false);
  const callPollInFlightRef = useRef(false);
  const handledTerminalCallIdsRef = useRef(new Set());
  const dismissCallOverlayTimerRef = useRef(0);
  const callReconnectTimerRef = useRef(0);
  const latestCallPollErrorAtRef = useRef(0);
  const incomingCallPollErrorAtRef = useRef(0);
  const lastLoggedOfferSdpRef = useRef("");
  const lastLoggedAnswerSdpRef = useRef("");
  const lastLoggedRemoteCandidatesKeyRef = useRef("");

  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshingConversations, setIsRefreshingConversations] = useState(false);
  const [friends, setFriends] = useState([]);
  const [incomingRequests, setIncomingRequests] = useState([]);
  const [outgoingRequests, setOutgoingRequests] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [totalUnread, setTotalUnread] = useState(0);
  const [snapshotErrors, setSnapshotErrors] = useState({
    friends: "",
    requests: "",
    conversations: ""
  });

  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [timelineItems, setTimelineItems] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState("");
  const [messageDraft, setMessageDraft] = useState("");
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [isStoppingVoice, setIsStoppingVoice] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordedVoiceBlob, setRecordedVoiceBlob] = useState(null);
  const [recordedVoiceDuration, setRecordedVoiceDuration] = useState(0);
  const [recordedVoicePreviewUrl, setRecordedVoicePreviewUrl] = useState("");
  const [isUploadingVoice, setIsUploadingVoice] = useState(false);
  const [voiceComposerError, setVoiceComposerError] = useState("");

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState("");

  const [notifications, setNotifications] = useState([]);
  const [notificationsUnread, setNotificationsUnread] = useState(0);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState("");
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [notificationSocketState, setNotificationSocketState] = useState("connecting");
  const [notificationActionLoadingKey, setNotificationActionLoadingKey] = useState("");
  const [presenceByUserId, setPresenceByUserId] = useState({});
  const [conversationActivity, setConversationActivity] = useState({});
  const [presenceSocketState, setPresenceSocketState] = useState("connecting");

  const [isChallengeComposerOpen, setIsChallengeComposerOpen] = useState(false);
  const [challengeForm, setChallengeForm] = useState({
    title: "Quick Quiz Challenge",
    category: CHALLENGE_CATEGORY_OPTIONS[0],
    difficulty: CHALLENGE_DIFFICULTY_OPTIONS[0],
    expiresInMinutes: CHALLENGE_EXPIRY_OPTIONS[2].value
  });
  const [challengeSubmitting, setChallengeSubmitting] = useState(false);
  const [challengeError, setChallengeError] = useState("");
  const [challengeActionLoadingKey, setChallengeActionLoadingKey] = useState("");

  const [actionLoadingKey, setActionLoadingKey] = useState("");
  const [statusNote, setStatusNote] = useState("");
  const [incomingCall, setIncomingCall] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const [callPhase, setRawCallPhase] = useState("idle");
  const [callDurationSeconds, setCallDurationSeconds] = useState(0);
  const [isCallMuted, setIsCallMuted] = useState(false);
  const [isCallSpeakerOn, setIsCallSpeakerOn] = useState(true);
  const [callError, setCallError] = useState("");
  const [isCallActionLoading, setIsCallActionLoading] = useState(false);

  const setCallPhase = (nextPhase) => {
    setRawCallPhase((previousPhase) => {
      const resolvedPhase =
        typeof nextPhase === "function" ? nextPhase(previousPhase) : nextPhase;
      if (!CALL_PHASES.has(resolvedPhase)) {
        console.warn("[VoiceCall] ignored invalid call phase", {
          previousPhase,
          requestedPhase: resolvedPhase
        });
        return previousPhase;
      }
      if (resolvedPhase !== previousPhase) {
        console.info("[VoiceCall] call state transition", {
          from: previousPhase,
          to: resolvedPhase,
          callId: callIdRef.current ?? activeCallRef.current?.id ?? incomingCallRef.current?.id ?? null
        });
      }
      return resolvedPhase;
    });
  };

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId]
  );
  const activePeer = activeConversation?.peer ?? null;
  const activePeerPresence = activePeer?.id ? presenceByUserId[activePeer.id] : null;
  const activeConversationActivity = activeConversation?.id
    ? conversationActivity[activeConversation.id]
    : null;
  const activePeerStatusLabel =
    activeConversationActivity?.type === "typing"
      ? "typing..."
      : activeConversationActivity?.type === "recording"
        ? "recording voice message..."
        : formatPresenceLabel(activePeerPresence);
  const isVoiceRecordingSupported =
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;
  const activeCallStatus = normalizeCallStatus(activeCall?.status);
  const isCallLive = Boolean(activeCall && CALL_ACTIVE_STATUSES.has(activeCallStatus));
  const isCallTerminal = Boolean(activeCall && CALL_TERMINAL_STATUSES.has(activeCallStatus));
  const activeCallPeer = useMemo(() => {
    if (!activeCall || !user?.id) {
      return null;
    }
    return activeCall.caller?.id === user.id ? activeCall.callee : activeCall.caller;
  }, [activeCall, user?.id]);
  const isActiveConversationCall =
    !!activeConversation &&
    !!activeCall &&
    activeConversation.id === activeCall.conversation_id &&
    isCallLive;
  const activePeerUnavailableForCall = Boolean(activePeerPresence?.in_call && !isActiveConversationCall);
  const activeConversationIncomingCall =
    !!incomingCall &&
    !!activeConversation &&
    incomingCall.conversation_id === activeConversation.id &&
    normalizeCallStatus(incomingCall.status) === "ringing";
  const isCallOverlayVisible =
    callPhase !== "idle" ||
    Boolean(incomingCall) ||
    (Boolean(activeCall) && !CALL_TERMINAL_STATUSES.has(normalizeCallStatus(activeCall?.status)));
  const callOverlayPeer = useMemo(() => {
    if ((callPhase === "incoming" || callPhase === "accepting") && incomingCall?.caller) {
      return incomingCall.caller;
    }
    if (activeCallPeer) {
      return activeCallPeer;
    }
    if (incomingCall?.caller) {
      return incomingCall.caller;
    }
    return activePeer;
  }, [activeCallPeer, activePeer, callPhase, incomingCall]);

  useEffect(() => {
    callPhaseRef.current = callPhase;
  }, [callPhase]);

  useEffect(() => {
    const isPresenceCallLive = [
      "starting",
      "calling",
      "ringing",
      "incoming",
      "accepting",
      "connecting",
      "connected",
      "active",
      "reconnecting"
    ].includes(callPhase);
    if (activeCallLiveRef.current === isPresenceCallLive) {
      return;
    }
    activeCallLiveRef.current = isPresenceCallLive;
    sendPresenceEvent({
      type: "call_status_update",
      in_call: isPresenceCallLive
    });
  }, [callPhase]);

  useEffect(() => {
    activeCallRef.current = activeCall;
  }, [activeCall]);

  useEffect(() => {
    incomingCallRef.current = incomingCall;
  }, [incomingCall]);

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
  }, [selectedConversationId]);

  const messageSummary = useMemo(() => {
    if (!messages.length) {
      return {
        totalMessages: 0,
        firstMessageAt: null,
        lastMessageAt: null
      };
    }

    return {
      totalMessages: messages.length,
      firstMessageAt: messages[0]?.created_at ?? null,
      lastMessageAt: messages[messages.length - 1]?.created_at ?? null
    };
  }, [messages]);

  const challengeSummary = useMemo(() => {
    const challengeCount = timelineItems.filter((item) => item.kind === "challenge").length;
    const pendingCount = timelineItems.filter(
      (item) =>
        item.kind === "challenge" &&
        item.challenge &&
        getChallengeStatusMeta(item.challenge).label === "Pending"
    ).length;
    return { challengeCount, pendingCount };
  }, [timelineItems]);

  const socialMomentum = useMemo(
    () => friends.length + conversations.length + incomingRequests.length + challengeSummary.challengeCount,
    [challengeSummary.challengeCount, conversations.length, friends.length, incomingRequests.length]
  );

  const estimatedLevel = useMemo(
    () => Math.max(1, Math.floor((socialMomentum + messageSummary.totalMessages) / 8) + 1),
    [messageSummary.totalMessages, socialMomentum]
  );

  const threadStreak = useMemo(() => {
    if (!activeConversation) {
      return 0;
    }
    return Math.max(1, Math.min(20, Math.floor(messageSummary.totalMessages / 3) + challengeSummary.challengeCount + 1));
  }, [activeConversation, challengeSummary.challengeCount, messageSummary.totalMessages]);

  const profileBadges = useMemo(() => {
    if (!activePeer) {
      return [];
    }
    const badges = [activeConversation?.can_message ? "Friend Linked" : "Invite Needed"];
    badges.push((activeConversation?.unread_count ?? 0) > 0 ? "Live Thread" : "Caught Up");
    badges.push(challengeSummary.challengeCount > 0 ? "Challenge Active" : "No Challenges Yet");
    return badges;
  }, [activeConversation, activePeer, challengeSummary.challengeCount]);

  const onlineFriendCount = useMemo(
    () =>
      friends.filter((friendship) => {
        const friendId = friendship?.friend?.id;
        return friendId && presenceByUserId[friendId]?.is_online;
      }).length,
    [friends, presenceByUserId]
  );

  const statusNoteClassName = STATUS_NOTE_ERROR_PATTERN.test(statusNote)
    ? "social-status-note is-error"
    : "social-status-note";

  const clearRecordingInterval = () => {
    if (recordingIntervalRef.current) {
      window.clearInterval(recordingIntervalRef.current);
      recordingIntervalRef.current = null;
    }
  };

  const stopRecordingStreamTracks = () => {
    if (!recordingStreamRef.current) {
      return;
    }
    recordingStreamRef.current.getTracks().forEach((track) => {
      track.stop();
    });
    recordingStreamRef.current = null;
  };

  const clearVoiceDraft = () => {
    setRecordedVoicePreviewUrl((previousUrl) => {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      return "";
    });
    setRecordedVoiceBlob(null);
    setRecordedVoiceDuration(0);
    setVoiceComposerError("");
    setIsStoppingVoice(false);
  };

  const uploadVoiceBlob = async ({ voiceBlob, durationInSeconds }) => {
    if (
      !selectedConversationId ||
      !activeConversation?.can_message ||
      !voiceBlob ||
      isUploadingVoice ||
      isRecordingVoice ||
      isStoppingVoice
    ) {
      return;
    }

    if (voiceBlob.size <= 0) {
      setVoiceComposerError("No audio captured. Please record again.");
      return;
    }

    const normalizedDuration = Number.isFinite(durationInSeconds)
      ? Math.max(1, Math.round(durationInSeconds))
      : 1;

    const extension = voiceBlob.type.includes("wav")
      ? ".wav"
      : voiceBlob.type.includes("mp4") || voiceBlob.type.includes("m4a")
        ? ".m4a"
        : voiceBlob.type.includes("mpeg") || voiceBlob.type.includes("mp3")
          ? ".mp3"
          : voiceBlob.type.includes("ogg")
            ? ".ogg"
            : ".webm";

    const file = new File([voiceBlob], `voice-${Date.now()}${extension}`, {
      type: voiceBlob.type || "audio/webm"
    });

    setIsUploadingVoice(true);
    setVoiceComposerError("");
    try {
      await sendConversationVoiceMessage(selectedConversationId, file, {
        durationSeconds: normalizedDuration
      });
      clearVoiceDraft();
      setStatusNote("Voice message sent.");
      await loadMessagesForConversation(selectedConversationId, {
        markSeen: false,
        silent: true
      });
      await Promise.all([refreshConversations(), loadNotifications({ silent: true })]);
    } catch (error) {
      setVoiceComposerError(toErrorMessage(error, "Unable to send voice message."));
    } finally {
      setIsUploadingVoice(false);
    }
  };

  const stopVoiceRecording = ({ discard = false, sendAfterStop = false } = {}) => {
    const recorder = mediaRecorderRef.current;
    if (isStoppingVoice) {
      return;
    }
    discardRecordingRef.current = discard;
    sendRecordingOnStopRef.current = sendAfterStop;

    if (!recorder || recorder.state === "inactive") {
      setIsRecordingVoice(false);
      setIsStoppingVoice(false);
      clearRecordingInterval();
      stopRecordingStreamTracks();
      if (selectedConversationIdRef.current) {
        sendPresenceEvent({
          type: "recording_stop",
          conversation_id: selectedConversationIdRef.current
        });
      }
      if (discard) {
        clearVoiceDraft();
      }
      if (sendAfterStop && recordedVoiceBlob) {
        void uploadVoiceBlob({
          voiceBlob: recordedVoiceBlob,
          durationInSeconds: recordedVoiceDuration
        });
      }
      return;
    }

    try {
      setIsStoppingVoice(true);
      recorder.stop();
    } catch (error) {
      console.warn("[VoiceMessage] failed to stop recorder cleanly", error);
      setIsRecordingVoice(false);
      setIsStoppingVoice(false);
      clearRecordingInterval();
      stopRecordingStreamTracks();
      if (selectedConversationIdRef.current) {
        sendPresenceEvent({
          type: "recording_stop",
          conversation_id: selectedConversationIdRef.current
        });
      }
    }
  };

  const handleStartVoiceRecording = async () => {
    if (
      !selectedConversationId ||
      !activeConversation?.can_message ||
      isUploadingVoice ||
      isSendingMessage ||
      isStoppingVoice
    ) {
      return;
    }

    if (!isVoiceRecordingSupported) {
      setVoiceComposerError("Voice recording is not supported in this browser.");
      return;
    }

    if (isRecordingVoice) {
      return;
    }

    clearVoiceDraft();
    setVoiceComposerError("");
    setIsStoppingVoice(false);

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("No microphone was found on this device.");
      }
      const mimeType = resolveRecorderMimeType();
      const recorder = mimeType
        ? new window.MediaRecorder(stream, { mimeType })
        : new window.MediaRecorder(stream);

      recordingStreamRef.current = stream;
      recordingChunksRef.current = [];
      recordingStartRef.current = Date.now();
      discardRecordingRef.current = false;
      sendRecordingOnStopRef.current = false;
      setRecordingSeconds(0);

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordingChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = (event) => {
        console.warn("[VoiceMessage] recorder error", event?.error ?? event);
        setVoiceComposerError("Unable to capture audio right now. Please try again.");
        stopVoiceRecording({ discard: true });
      };

      recorder.onstop = () => {
        clearRecordingInterval();
        setIsRecordingVoice(false);
        setIsStoppingVoice(false);
        if (selectedConversationIdRef.current) {
          sendPresenceEvent({
            type: "recording_stop",
            conversation_id: selectedConversationIdRef.current
          });
        }

        stream.getTracks().forEach((track) => track.stop());
        if (recordingStreamRef.current === stream) {
          recordingStreamRef.current = null;
        }
        mediaRecorderRef.current = null;

        if (discardRecordingRef.current) {
          recordingChunksRef.current = [];
          discardRecordingRef.current = false;
          sendRecordingOnStopRef.current = false;
          setRecordingSeconds(0);
          return;
        }

        const shouldSendImmediately = sendRecordingOnStopRef.current;
        sendRecordingOnStopRef.current = false;

        const chunks = recordingChunksRef.current;
        recordingChunksRef.current = [];
        if (!chunks.length) {
          setVoiceComposerError("No audio captured. Please record again.");
          setRecordingSeconds(0);
          return;
        }

        const elapsedMs = Date.now() - recordingStartRef.current;
        if (elapsedMs < MIN_VOICE_RECORDING_MS) {
          setVoiceComposerError("Voice message is too short. Record a little longer.");
          setRecordingSeconds(0);
          return;
        }

        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        const elapsedSeconds = Math.max(
          1,
          Math.round(elapsedMs / 1000)
        );
        setRecordingSeconds(0);

        if (shouldSendImmediately) {
          void uploadVoiceBlob({
            voiceBlob: blob,
            durationInSeconds: elapsedSeconds
          });
          return;
        }

        setRecordedVoiceBlob(blob);
        setRecordedVoiceDuration(elapsedSeconds);
        setRecordedVoicePreviewUrl(URL.createObjectURL(blob));
      };

      mediaRecorderRef.current = recorder;
      recorder.start(200);
      setIsRecordingVoice(true);
      sendPresenceEvent({
        type: "recording_start",
        conversation_id: selectedConversationId
      });
      recordingIntervalRef.current = window.setInterval(() => {
        setRecordingSeconds(
          Math.max(0, Math.round((Date.now() - recordingStartRef.current) / 1000))
        );
      }, RECORDING_UPDATE_INTERVAL_MS);
    } catch (error) {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      if (selectedConversationIdRef.current) {
        sendPresenceEvent({
          type: "recording_stop",
          conversation_id: selectedConversationIdRef.current
        });
      }
      if (recordingStreamRef.current === stream) {
        recordingStreamRef.current = null;
      }
      console.warn("[VoiceMessage] microphone unavailable", error);
      setVoiceComposerError(getMicrophoneErrorMessage(error));
      setIsRecordingVoice(false);
      setIsStoppingVoice(false);
      clearRecordingInterval();
    }
  };

  const handleSendVoiceMessage = async () => {
    if (isStoppingVoice || isUploadingVoice) {
      return;
    }
    if (isRecordingVoice) {
      stopVoiceRecording({ discard: false, sendAfterStop: true });
      return;
    }
    if (!recordedVoiceBlob) {
      return;
    }
    await uploadVoiceBlob({
      voiceBlob: recordedVoiceBlob,
      durationInSeconds: recordedVoiceDuration
    });
  };

  const clearCallDismissTimer = () => {
    if (dismissCallOverlayTimerRef.current) {
      window.clearTimeout(dismissCallOverlayTimerRef.current);
      dismissCallOverlayTimerRef.current = 0;
    }
  };

  const clearCallReconnectTimer = () => {
    if (callReconnectTimerRef.current) {
      window.clearTimeout(callReconnectTimerRef.current);
      callReconnectTimerRef.current = 0;
    }
  };

  const stopLocalCallStream = () => {
    if (localCallStreamRef.current) {
      console.info("[VoiceCall] stopping local stream", {
        trackCount: localCallStreamRef.current.getTracks().length
      });
      localCallStreamRef.current.getTracks().forEach((track) => {
        track.stop();
      });
      localCallStreamRef.current = null;
    }
  };

  const stopRemoteCallStream = () => {
    if (remoteCallStreamRef.current) {
      console.info("[VoiceCall] stopping remote stream", {
        trackCount: remoteCallStreamRef.current.getTracks().length
      });
      remoteCallStreamRef.current.getTracks().forEach((track) => {
        track.stop();
      });
      remoteCallStreamRef.current = null;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
  };

  const closePeerConnection = () => {
    const peer = peerConnectionRef.current;
    clearCallReconnectTimer();
    if (!peer) {
      return;
    }

    console.info("[VoiceCall] closing peer connection", {
      callId: callIdRef.current,
      connectionState: peer.connectionState,
      iceConnectionState: peer.iceConnectionState,
      signalingState: peer.signalingState
    });
    peer.onicecandidate = null;
    peer.ontrack = null;
    peer.onconnectionstatechange = null;
    peer.oniceconnectionstatechange = null;
    peer.onsignalingstatechange = null;
    try {
      peer.getSenders().forEach((sender) => {
        try {
          sender.replaceTrack(null);
        } catch {
          // noop
        }
      });
      peer.close();
    } catch {
      // noop
    }
    peerConnectionRef.current = null;
  };

  const hardResetCallState = ({ preserveError = false } = {}) => {
    console.info("[VoiceCall] cleanup start", {
      callId: callIdRef.current,
      phase: callPhaseRef.current,
      preserveError
    });
    clearCallDismissTimer();
    clearCallReconnectTimer();
    closePeerConnection();
    stopLocalCallStream();
    stopRemoteCallStream();
    callIdRef.current = null;
    pendingLocalCandidatesRef.current = [];
    pendingIceCandidatesRef.current = [];
    remoteCandidateSignaturesRef.current = new Set();
    remoteDescriptionSignatureRef.current = "";
    activationRequestRef.current = false;
    previousCallStatusRef.current = "";
    lastLoggedOfferSdpRef.current = "";
    lastLoggedAnswerSdpRef.current = "";
    lastLoggedRemoteCandidatesKeyRef.current = "";
    callActionLockRef.current = false;
    setIncomingCall(null);
    setActiveCall(null);
    setCallPhase("idle");
    setCallDurationSeconds(0);
    setIsCallMuted(false);
    setIsCallSpeakerOn(true);
    setIsCallActionLoading(false);
    if (!preserveError) {
      setCallError("");
    }
    console.info("[VoiceCall] cleanup finish");
  };

  const scheduleCallOverlayDismiss = (delayMs = 1250) => {
    clearCallDismissTimer();
    dismissCallOverlayTimerRef.current = window.setTimeout(() => {
      hardResetCallState();
    }, delayMs);
  };

  const ensureLocalCallStream = async () => {
    if (localCallStreamRef.current && localCallStreamRef.current.getAudioTracks().length > 0) {
      localCallStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !isCallMuted;
      });
      return localCallStreamRef.current;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Voice calling is not supported in this browser.");
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("No microphone input was detected.");
      }

      audioTracks.forEach((track) => {
        track.enabled = !isCallMuted;
      });
      localCallStreamRef.current = stream;
      console.info("[VoiceCall] local stream started", {
        trackCount: audioTracks.length
      });
      return stream;
    } catch (error) {
      console.error("[VoiceCall] getUserMedia failed", error);
      const errorName = typeof error?.name === "string" ? error.name : "";
      if (errorName === "NotAllowedError" || errorName === "SecurityError") {
        throw new Error("Microphone permission was denied.");
      }
      if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
        throw new Error("No microphone device was found.");
      }
      if (errorName === "NotReadableError" || errorName === "TrackStartError") {
        throw new Error("Microphone is currently busy. Close other apps using it and try again.");
      }
      throw new Error(
        typeof error?.message === "string" && error.message.trim()
          ? error.message
          : "Unable to access microphone."
      );
    }
  };

  const playRemoteAudio = async () => {
    const audioElement = remoteAudioRef.current;
    if (!audioElement) {
      return;
    }
    audioElement.muted = !isCallSpeakerOn;
    audioElement.volume = isCallSpeakerOn ? 1 : 0;
    try {
      await audioElement.play();
    } catch (error) {
      console.warn("[VoiceCall] remote audio playback waiting for user gesture", {
        callId: callIdRef.current,
        message: error?.message ?? "play() blocked"
      });
      // Browser autoplay restrictions can block play(). User interaction controls remain available.
    }
  };

  const flushPendingIceCandidates = async () => {
    const peer = peerConnectionRef.current;
    if (!peer || !peer.remoteDescription) {
      return;
    }
    const pending = pendingIceCandidatesRef.current;
    if (!pending.length) {
      return;
    }
    const queue = [...pending];
    pendingIceCandidatesRef.current = [];
    for (const rawCandidate of queue) {
      try {
        const candidate = normalizeIceCandidateInput(
          rawCandidate,
          "Pending remote ICE candidate"
        );
        console.info("[VoiceCall] signaling message received", {
          type: "candidate",
          callId: callIdRef.current
        });
        console.info("[VoiceCall] addIceCandidate(pending remote)", {
          callId: callIdRef.current,
          candidate: candidate?.candidate ?? null,
          sdpMid: candidate?.sdpMid ?? null,
          sdpMLineIndex: candidate?.sdpMLineIndex ?? null
        });
        await peer.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.warn("[VoiceCall] ignored invalid pending remote ICE candidate", error);
      }
    }
  };

  const flushPendingLocalCandidates = async () => {
    if (!callIdRef.current || !pendingLocalCandidatesRef.current.length) {
      return;
    }
    const queuedCandidates = [...pendingLocalCandidatesRef.current];
    pendingLocalCandidatesRef.current = [];
    console.info("[VoiceCall] flushing queued local ICE candidates", {
      callId: callIdRef.current,
      count: queuedCandidates.length
    });
    for (const candidatePayload of queuedCandidates) {
      try {
        console.info("[VoiceCall] sending queued local ICE candidate", {
          type: "candidate",
          callId: callIdRef.current
        });
        await addCallCandidate(callIdRef.current, candidatePayload);
      } catch (error) {
        logVoiceCallError("flush_local_candidate", error, {
          callId: callIdRef.current
        });
      }
    }
  };

  const applyRemoteCandidateList = async (callSnapshot) => {
    const peer = peerConnectionRef.current;
    if (!peer || !callSnapshot || !callSnapshot.id) {
      return;
    }

    const remoteCandidates = callSnapshot.is_outgoing
      ? Array.isArray(callSnapshot.callee_candidates)
        ? callSnapshot.callee_candidates
        : []
      : Array.isArray(callSnapshot.caller_candidates)
        ? callSnapshot.caller_candidates
        : [];
    const remoteCandidatesKey = remoteCandidates.map((candidate) => candidateSignature(candidate)).join("||");
    if (remoteCandidatesKey && remoteCandidatesKey !== lastLoggedRemoteCandidatesKeyRef.current) {
      lastLoggedRemoteCandidatesKeyRef.current = remoteCandidatesKey;
      console.info("[VoiceCall] received remote ICE candidates", {
        callId: callSnapshot.id,
        count: remoteCandidates.length
      });
    }

    for (const rawCandidate of remoteCandidates) {
      let candidate;
      try {
        candidate = normalizeIceCandidateInput(rawCandidate, "Remote ICE candidate");
      } catch (error) {
        console.warn("[VoiceCall] ignored invalid remote ICE candidate", error, rawCandidate);
        continue;
      }
      const signature = candidateSignature(candidate);
      if (!signature || remoteCandidateSignaturesRef.current.has(signature)) {
        continue;
      }
      remoteCandidateSignaturesRef.current.add(signature);
      if (!peer.remoteDescription) {
        pendingIceCandidatesRef.current.push(candidate);
        continue;
      }
      try {
        console.info("[VoiceCall] signaling message received", {
          type: "candidate",
          callId: callSnapshot.id
        });
        console.info("[VoiceCall] addIceCandidate(remote)", {
          callId: callSnapshot.id,
          candidate: candidate?.candidate ?? null,
          sdpMid: candidate?.sdpMid ?? null,
          sdpMLineIndex: candidate?.sdpMLineIndex ?? null
        });
        await peer.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.warn("[VoiceCall] failed to apply remote ICE candidate", error);
      }
    }
  };

  const applyCallerRemoteDescription = async (answerSdp) => {
    const peer = peerConnectionRef.current;
    if (!peer || !answerSdp) {
      return;
    }
    let remoteDescription;
    try {
      remoteDescription = normalizeSessionDescriptionInput(answerSdp, "answer", "Remote answer");
    } catch (error) {
      logVoiceCallError("normalize_answer", error, {
        callId: callIdRef.current
      });
      throw error;
    }
    const normalizedAnswer = remoteDescription.sdp;
    if (!normalizedAnswer) {
      return;
    }
    if (remoteDescriptionSignatureRef.current === normalizedAnswer) {
      return;
    }
    if (peer.currentRemoteDescription?.sdp === normalizedAnswer) {
      remoteDescriptionSignatureRef.current = normalizedAnswer;
      return;
    }
    try {
      logSignalingPayload("setRemoteDescription(answer)", remoteDescription, {
        callId: callIdRef.current
      });
      console.info("[VoiceCall] signaling message received", {
        type: remoteDescription.type,
        callId: callIdRef.current
      });
      const appliedDescription = await applyRemoteDescriptionWithSdpFallback(
        peer,
        remoteDescription,
        "Remote answer"
      );
      remoteDescriptionSignatureRef.current = appliedDescription.sdp;
      await flushPendingIceCandidates();
    } catch (error) {
      logVoiceCallError("set_remote_answer", error, {
        callId: callIdRef.current,
        sdpLength: normalizedAnswer.length,
        sdpPreview: signalingSdpPreview(normalizedAnswer)
      });
      throw error;
    }
  };

  const createCallPeerConnection = async ({ localStream }) => {
    closePeerConnection();
    callIdRef.current = null;
    pendingLocalCandidatesRef.current = [];
    remoteCandidateSignaturesRef.current = new Set();
    remoteDescriptionSignatureRef.current = "";
    pendingIceCandidatesRef.current = [];
    activationRequestRef.current = false;
    lastLoggedRemoteCandidatesKeyRef.current = "";

    if (typeof window.RTCPeerConnection === "undefined") {
      throw new Error("WebRTC is not supported in this browser.");
    }

    const peer = new RTCPeerConnection(RTC_CONFIGURATION);
    peerConnectionRef.current = peer;
    console.info("[VoiceCall] peer connection created", {
      phase: callPhaseRef.current
    });

    localStream.getAudioTracks().forEach((track) => {
      peer.addTrack(track, localStream);
    });

    peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (stream) {
        console.info("[VoiceCall] remote track received", {
          callId: callIdRef.current,
          trackCount: stream.getAudioTracks().length
        });
        remoteCallStreamRef.current = stream;
        if (remoteAudioRef.current && remoteAudioRef.current.srcObject !== stream) {
          remoteAudioRef.current.srcObject = stream;
        }
        void playRemoteAudio();
      }
    };

    peer.onicecandidate = (event) => {
      const candidate = event.candidate;
      if (!candidate) {
        return;
      }
      const candidatePayload = normalizeIceCandidateInput(
        candidate.toJSON(),
        "Local ICE candidate"
      );
      console.info("[VoiceCall] local ICE candidate generated", {
        type: "candidate",
        callId: callIdRef.current,
        candidate: candidatePayload?.candidate ?? null,
        sdpMid: candidatePayload?.sdpMid ?? null,
        sdpMLineIndex: candidatePayload?.sdpMLineIndex ?? null
      });
      if (!callIdRef.current) {
        pendingLocalCandidatesRef.current.push(candidatePayload);
        return;
      }
      console.info("[VoiceCall] sending local ICE candidate", {
        type: "candidate",
        callId: callIdRef.current
      });
      void addCallCandidate(callIdRef.current, candidatePayload).catch((error) => {
        logVoiceCallError("send_local_candidate", error, {
          callId: callIdRef.current
        });
      });
    };

    peer.onicecandidateerror = (event) => {
      console.warn("[VoiceCall] ICE candidate error", {
        address: event?.address ?? null,
        port: event?.port ?? null,
        url: event?.url ?? null,
        errorCode: event?.errorCode ?? null,
        errorText: event?.errorText ?? null
      });
    };

    const syncConnectionPhase = () => {
      const connectionState = peer.connectionState;
      console.info("[VoiceCall] peer connection state", {
        callId: callIdRef.current,
        connectionState,
        iceConnectionState: peer.iceConnectionState,
        signalingState: peer.signalingState
      });
      if (connectionState === "connected") {
        clearCallReconnectTimer();
        setCallPhase("connected");
        if (!activationRequestRef.current && callIdRef.current) {
          activationRequestRef.current = true;
          void activateCall(callIdRef.current)
            .then((snapshot) => {
              if (snapshot?.id === callIdRef.current) {
                setActiveCall(snapshot);
              }
            })
            .catch((error) => {
              console.warn("[VoiceCall] failed to activate connected call", error);
            })
            .finally(() => {
              activationRequestRef.current = false;
            });
        }
      } else if (connectionState === "connecting") {
        setCallPhase((previous) =>
          previous === "active" || previous === "connected" ? previous : "connecting"
        );
      } else if (connectionState === "disconnected") {
        setCallPhase((previous) =>
          previous === "active" || previous === "connected" ? "reconnecting" : previous
        );
        clearCallReconnectTimer();
        callReconnectTimerRef.current = window.setTimeout(() => {
          if (peerConnectionRef.current !== peer || peer.connectionState === "connected") {
            return;
          }
          console.warn("[VoiceCall] reconnect grace period expired", {
            callId: callIdRef.current,
            connectionState: peer.connectionState,
            iceConnectionState: peer.iceConnectionState
          });
          setCallError("Connection lost. Ending call.");
          setCallPhase("failed");
          if (callIdRef.current) {
            void endCall(callIdRef.current).catch((error) => {
              console.error("[VoiceCall] failed to end call after reconnect timeout", error);
            });
          }
          scheduleCallOverlayDismiss(1400);
        }, CALL_RECONNECT_TIMEOUT_MS);
      } else if (connectionState === "failed") {
        clearCallReconnectTimer();
        const currentCallStatus = normalizeCallStatus(activeCallRef.current?.status);
        const hasRemoteDescription = Boolean(
          peer.currentRemoteDescription || remoteDescriptionSignatureRef.current
        );
        if (!hasRemoteDescription && currentCallStatus === "ringing") {
          console.warn("[VoiceCall] ignoring premature failed state while remote answer is pending");
          setCallPhase("calling");
          return;
        }
        console.error("[VoiceCall] peer connection failed", {
          connectionState: peer.connectionState,
          iceConnectionState: peer.iceConnectionState,
          signalingState: peer.signalingState
        });
        setCallError("Connection dropped. Ending call.");
        setCallPhase("failed");
        if (callIdRef.current) {
          void endCall(callIdRef.current).catch((error) => {
            console.error("[VoiceCall] failed to end call after connection failure", error);
          });
        }
        scheduleCallOverlayDismiss(1400);
      } else if (connectionState === "closed" && callPhaseRef.current !== "idle") {
        setCallPhase((previous) => (previous === "idle" ? previous : "ended"));
      }
    };

    peer.onconnectionstatechange = syncConnectionPhase;
    peer.oniceconnectionstatechange = syncConnectionPhase;

    return peer;
  };

  const applyCallSnapshot = async (snapshot) => {
    if (!snapshot || !snapshot.id) {
      return;
    }

    const status = normalizeCallStatus(snapshot.status);
    const isTerminalSnapshot = CALL_TERMINAL_STATUSES.has(status);
    const isKnownCall =
      callIdRef.current === snapshot.id ||
      activeCallRef.current?.id === snapshot.id ||
      incomingCallRef.current?.id === snapshot.id;

    if (isTerminalSnapshot && handledTerminalCallIdsRef.current.has(snapshot.id) && !isKnownCall) {
      return;
    }

    if (isTerminalSnapshot && callPhaseRef.current === "idle" && !isKnownCall) {
      handledTerminalCallIdsRef.current.add(snapshot.id);
      return;
    }

    const offerSnapshotSdp = readRawSdp(snapshot.offer_sdp);
    if (offerSnapshotSdp && offerSnapshotSdp !== lastLoggedOfferSdpRef.current) {
      try {
        const offerDescription = normalizeSessionDescriptionInput(
          snapshot.offer_sdp,
          "offer",
          "Received offer snapshot"
        );
        logSignalingPayload("received offer snapshot", offerDescription, {
          callId: snapshot.id,
          status: snapshot.status
        });
        lastLoggedOfferSdpRef.current = offerDescription.sdp;
      } catch (error) {
        logVoiceCallError("snapshot_offer_parse", error, {
          callId: snapshot.id,
          status: snapshot.status
        });
      }
    }
    const answerSnapshotSdp = readRawSdp(snapshot.answer_sdp);
    if (answerSnapshotSdp && answerSnapshotSdp !== lastLoggedAnswerSdpRef.current) {
      try {
        const answerDescription = normalizeSessionDescriptionInput(
          snapshot.answer_sdp,
          "answer",
          "Received answer snapshot"
        );
        logSignalingPayload("received answer snapshot", answerDescription, {
          callId: snapshot.id,
          status: snapshot.status
        });
        lastLoggedAnswerSdpRef.current = answerDescription.sdp;
      } catch (error) {
        logVoiceCallError("snapshot_answer_parse", error, {
          callId: snapshot.id,
          status: snapshot.status
        });
      }
    }

    callIdRef.current = snapshot.id;
    setActiveCall(snapshot);
    previousCallStatusRef.current = status;
    await flushPendingLocalCandidates();

    if (status === "ringing" && snapshot.is_incoming) {
      setIncomingCall(snapshot);
      setCallPhase("incoming");
      return;
    }

    if (status === "ringing" && snapshot.is_outgoing) {
      setIncomingCall(null);
      setCallPhase((previous) =>
        ["idle", "starting", "incoming", "failed"].includes(previous) ? "calling" : previous
      );
    } else if (status === "connecting") {
      setIncomingCall(null);
      setCallPhase((previous) =>
        previous === "active" || previous === "connected" ? previous : "connecting"
      );
    } else if (status === "active") {
      setIncomingCall(null);
      setCallPhase("connected");
    }

    if (snapshot.is_outgoing && snapshot.answer_sdp) {
      await applyCallerRemoteDescription(snapshot.answer_sdp);
    }
    await applyRemoteCandidateList(snapshot);
    await flushPendingIceCandidates();

    if (CALL_TERMINAL_STATUSES.has(status)) {
      handledTerminalCallIdsRef.current.add(snapshot.id);
      console.info("[VoiceCall] terminal call snapshot received", {
        callId: snapshot.id,
        status
      });
      closePeerConnection();
      stopLocalCallStream();
      stopRemoteCallStream();
      callIdRef.current = null;
      setIncomingCall(null);
      setCallDurationSeconds(
        Number.isFinite(snapshot.duration_seconds) ? snapshot.duration_seconds : callDurationSeconds
      );
      if (status === "declined") {
        setCallPhase("declined");
      } else if (status === "canceled") {
        setCallPhase("canceled");
      } else if (status === "missed") {
        setCallPhase("missed");
      } else {
        setCallPhase("ended");
      }
      scheduleCallOverlayDismiss();
    }
  };

  const pollCallState = async () => {
    if (callPollInFlightRef.current) {
      return;
    }
    callPollInFlightRef.current = true;
    const conversationForCallSync =
      activeCallRef.current?.conversation_id ??
      incomingCallRef.current?.conversation_id ??
      selectedConversationId;
    try {
      try {
        if (conversationForCallSync) {
          const latest = await getLatestConversationCall(conversationForCallSync);
          if (latest?.id) {
            await applyCallSnapshot(latest);
          }
        }
      } catch (error) {
        const now = Date.now();
        if (now - latestCallPollErrorAtRef.current > 8000) {
          latestCallPollErrorAtRef.current = now;
          logVoiceCallError("poll_latest_call", error, {
            conversationId: conversationForCallSync ?? null,
            callId: callIdRef.current
          });
        }
      }

      try {
        const incomingRows = await listIncomingCalls({ limit: CALL_POLLING_LIMIT });
        const ringingIncoming = Array.isArray(incomingRows)
          ? incomingRows.find((row) => normalizeCallStatus(row?.status) === "ringing")
          : null;
        if (ringingIncoming?.id) {
          if (callPhaseRef.current === "idle" || callPhaseRef.current === "incoming") {
            console.info("[VoiceCall] incoming call received", {
              callId: ringingIncoming.id,
              conversationId: ringingIncoming.conversation_id
            });
            setIncomingCall((previous) =>
              previous?.id === ringingIncoming.id ? previous : ringingIncoming
            );
            setCallPhase("incoming");
          }
        } else if (callPhaseRef.current === "incoming" && !callActionLockRef.current) {
          setIncomingCall(null);
          setCallPhase("idle");
        }
      } catch (error) {
        const now = Date.now();
        if (now - incomingCallPollErrorAtRef.current > 8000) {
          incomingCallPollErrorAtRef.current = now;
          logVoiceCallError("poll_incoming_calls", error, {
            callId: callIdRef.current
          });
        }
      }
    } finally {
      callPollInFlightRef.current = false;
    }
  };

  const handleStartVoiceCall = async () => {
    if (
      !activeConversation?.id ||
      !activeConversation.can_message ||
      isCallActionLoading ||
      callActionLockRef.current
    ) {
      return;
    }
    if (isCallLive && activeCall?.conversation_id === activeConversation.id) {
      setCallPhase("active");
      return;
    }

    callActionLockRef.current = true;
    clearCallDismissTimer();
    setCallError("");
    setIsCallActionLoading(true);
    setIncomingCall(null);
    setCallDurationSeconds(0);
    setCallPhase("starting");

    try {
      console.info("[VoiceCall] outgoing call started", {
        conversationId: activeConversation.id
      });
      const localStream = await ensureLocalCallStream();
      const peer = await createCallPeerConnection({ localStream });
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const localOffer = peer.localDescription || offer;
      console.info("[VoiceCall] caller created local offer", {
        type: localOffer?.type ?? null,
        conversationId: activeConversation.id,
        sdpLength: localOffer?.sdp?.length ?? 0,
        sdpStart: localOffer?.sdp?.slice(0, 120) ?? "",
        startsWithV0: Boolean(localOffer?.sdp?.startsWith("v=0"))
      });
      const offerDescription = normalizeSessionDescriptionInput(
        {
          type: "offer",
          sdp: localOffer?.sdp ?? ""
        },
        "offer",
        "Local offer"
      );
      logSignalingPayload("send offer", offerDescription, {
        conversationId: activeConversation.id
      });

      console.info("[VoiceCall] caller sending offer payload", {
        type: "offer",
        conversationId: activeConversation.id,
        sdpLength: offerDescription.sdp.length,
        sdpStart: offerDescription.sdp.slice(0, 120),
        startsWithV0: offerDescription.sdp.startsWith("v=0")
      });

      const callSnapshot = await startConversationCall(activeConversation.id, offerDescription);
      if (!callSnapshot?.id) {
        throw new Error("Call session was not created by server.");
      }
      if (callSnapshot?.offer_sdp) {
        const normalizedServerOffer = normalizeSessionDescriptionInput(
          callSnapshot.offer_sdp,
          "offer",
          "Server offer"
        );
        if (normalizedServerOffer.sdp !== offerDescription.sdp) {
          console.warn("[VoiceCall] server returned offer SDP different from local offer", {
            conversationId: activeConversation.id
          });
        }
      }
      logSignalingPayload(
        "received call snapshot (start)",
        { type: "offer", sdp: readRawSdp(callSnapshot?.offer_sdp) },
        {
          callId: callSnapshot?.id ?? null,
          status: callSnapshot?.status ?? null
        }
      );
      callIdRef.current = callSnapshot.id;
      handledTerminalCallIdsRef.current.delete(callSnapshot.id);
      setActiveCall(callSnapshot);
      setCallPhase("calling");
      setStatusNote("Calling started.");
      await flushPendingLocalCandidates();
      await applyRemoteCandidateList(callSnapshot);
      await Promise.all([refreshConversations(), loadNotifications({ silent: true })]);
    } catch (error) {
      logVoiceCallError("start", error, {
        conversationId: activeConversation?.id ?? null,
        callId: callIdRef.current
      });
      closePeerConnection();
      stopLocalCallStream();
      stopRemoteCallStream();
      callIdRef.current = null;
      setIncomingCall(null);
      setActiveCall(null);
      setCallPhase("failed");
      setCallError(toErrorMessage(error, "Unable to start voice call."));
      scheduleCallOverlayDismiss(1600);
    } finally {
      callActionLockRef.current = false;
      setIsCallActionLoading(false);
    }
  };

  const handleAcceptIncomingCall = async () => {
    const incoming = incomingCallRef.current;
    if (!incoming?.id || isCallActionLoading || callActionLockRef.current) {
      return;
    }
    callActionLockRef.current = true;
    clearCallDismissTimer();
    setCallError("");
    setIsCallActionLoading(true);
    setCallPhase("accepting");

    try {
      console.info("[VoiceCall] accept clicked", {
        callId: incoming.id,
        conversationId: incoming.conversation_id,
        phaseBeforeAccept: callPhaseRef.current,
        activeCallId: activeCallRef.current?.id ?? null,
        incomingStatus: incoming.status ?? null
      });
      if (incoming.conversation_id) {
        setSelectedConversationId(incoming.conversation_id);
      }

      const localStream = await ensureLocalCallStream();
      const peer = await createCallPeerConnection({
        localStream
      });

      if (!incoming.offer_sdp) {
        throw new Error("Incoming offer is missing.");
      }
      const incomingOfferDescription = normalizeSessionDescriptionInput(
        incoming.offer_sdp,
        "offer",
        "Incoming offer"
      );
      console.info("[VoiceCall] receiver received offer", {
        callId: incoming.id,
        conversationId: incoming.conversation_id,
        sdpLength: incomingOfferDescription.sdp.length,
        sdpStart: incomingOfferDescription.sdp.slice(0, 120),
        startsWithV0: incomingOfferDescription.sdp.startsWith("v=0")
      });
      logSignalingPayload("setRemoteDescription(offer)", incomingOfferDescription, {
        callId: incoming.id,
        conversationId: incoming.conversation_id
      });
      console.info("[VoiceCall] signaling message received", {
        type: incomingOfferDescription.type,
        callId: incoming.id
      });

      if (incomingOfferDescription.type !== "offer" || !incomingOfferDescription.sdp.startsWith("v=0")) {
        throw new Error("Incoming offer is not a full SDP offer.");
      }
      const appliedOfferDescription = await applyRemoteDescriptionWithSdpFallback(
        peer,
        incomingOfferDescription,
        "Incoming offer"
      );
      remoteDescriptionSignatureRef.current = appliedOfferDescription.sdp;
      await applyRemoteCandidateList(incoming);
      await flushPendingIceCandidates();

      const answer = await peer.createAnswer();
      console.info("[VoiceCall] answer created", {
        callId: incoming.id,
        sdpLength: answer?.sdp?.length ?? 0
      });
      await peer.setLocalDescription(answer);
      const answerDescription = normalizeSessionDescriptionInput(
        {
          type: "answer",
          sdp: answer?.sdp ?? ""
        },
        "answer",
        "Local answer"
      );
      logSignalingPayload("send answer", answerDescription, {
        callId: incoming.id,
        conversationId: incoming.conversation_id
      });

      const acceptedSnapshot = await acceptCall(incoming.id, answerDescription);
      if (!acceptedSnapshot?.id) {
        throw new Error("Call session was not updated by server.");
      }
      if (acceptedSnapshot?.answer_sdp) {
        const normalizedServerAnswer = normalizeSessionDescriptionInput(
          acceptedSnapshot.answer_sdp,
          "answer",
          "Server answer"
        );
        if (normalizedServerAnswer.sdp !== answerDescription.sdp) {
          console.warn("[VoiceCall] server returned answer SDP different from local answer", {
            callId: acceptedSnapshot.id
          });
        }
      }
      logSignalingPayload(
        "received call snapshot (accept)",
        { type: "answer", sdp: readRawSdp(acceptedSnapshot?.answer_sdp) },
        {
          callId: acceptedSnapshot?.id ?? null,
          status: acceptedSnapshot?.status ?? null
        }
      );
      callIdRef.current = acceptedSnapshot.id;
      handledTerminalCallIdsRef.current.delete(acceptedSnapshot.id);
      setIncomingCall(null);
      setActiveCall(acceptedSnapshot);
      setCallPhase("connecting");
      await flushPendingLocalCandidates();
      await applyRemoteCandidateList(acceptedSnapshot);
      Promise.all([
        refreshConversations(),
        loadNotifications({ silent: true }),
        loadMessagesForConversation(acceptedSnapshot.conversation_id, {
          markSeen: false,
          silent: true
        })
      ]).catch((refreshError) => {
        logVoiceCallError("accept_refresh", refreshError, {
          callId: acceptedSnapshot.id,
          conversationId: acceptedSnapshot.conversation_id
        });
      });
    } catch (error) {
      logVoiceCallError("accept", error, {
        incomingCallId: incoming?.id ?? null,
        conversationId: incoming?.conversation_id ?? null,
        phaseAfterAcceptError: callPhaseRef.current
      });
      closePeerConnection();
      stopLocalCallStream();
      stopRemoteCallStream();
      callIdRef.current = null;
      setActiveCall(null);
      setIncomingCall(incoming);
      setCallPhase("incoming");
      setCallError(toErrorMessage(error, "Unable to accept this call."));
    } finally {
      callActionLockRef.current = false;
      setIsCallActionLoading(false);
    }
  };

  const handleDeclineIncomingCall = async () => {
    const incoming = incomingCallRef.current;
    if (!incoming?.id || isCallActionLoading || callActionLockRef.current) {
      return;
    }
    callActionLockRef.current = true;
    console.info("[VoiceCall] decline clicked", {
      callId: incoming.id,
      conversationId: incoming.conversation_id
    });
    clearCallDismissTimer();
    setIsCallActionLoading(true);
    setIncomingCall(null);
    setCallPhase("declined");
    closePeerConnection();
    stopLocalCallStream();
    stopRemoteCallStream();
    try {
      const snapshot = await declineCall(incoming.id);
      await applyCallSnapshot(snapshot);
      setStatusNote("Call declined.");
      await Promise.all([refreshConversations(), loadNotifications({ silent: true })]);
    } catch (error) {
      logVoiceCallError("decline", error, {
        incomingCallId: incoming?.id ?? null,
        conversationId: incoming?.conversation_id ?? null
      });
      setCallError(toErrorMessage(error, "Unable to decline the call."));
      setCallPhase("failed");
      scheduleCallOverlayDismiss(1400);
    } finally {
      callActionLockRef.current = false;
      setIsCallActionLoading(false);
    }
  };

  const handleCancelOrEndCall = async () => {
    const currentCall = activeCallRef.current || incomingCallRef.current;
    if (!currentCall?.id || isCallActionLoading || callActionLockRef.current) {
      hardResetCallState();
      return;
    }

    callActionLockRef.current = true;
    setIsCallActionLoading(true);
    setCallError("");
    try {
      console.info("[VoiceCall] hangup clicked", {
        callId: currentCall.id,
        conversationId: currentCall.conversation_id,
        phase: callPhaseRef.current,
        status: currentCall.status
      });
      const status = normalizeCallStatus(currentCall.status);
      closePeerConnection();
      stopLocalCallStream();
      stopRemoteCallStream();
      setIncomingCall(null);
      setCallPhase(status === "ringing" ? "canceled" : "ended");
      let snapshot;
      if (callPhaseRef.current === "incoming") {
        snapshot = await declineCall(currentCall.id);
      } else if (status === "ringing" && currentCall.is_outgoing) {
        snapshot = await cancelCall(currentCall.id);
      } else {
        snapshot = await endCall(currentCall.id);
      }

      await applyCallSnapshot(snapshot);
      await Promise.all([
        refreshConversations(),
        loadNotifications({ silent: true }),
        loadMessagesForConversation(currentCall.conversation_id, {
          markSeen: false,
          silent: true
        })
      ]);
    } catch (error) {
      logVoiceCallError("cancel_or_end", error, {
        callId: currentCall?.id ?? null,
        conversationId: currentCall?.conversation_id ?? null,
        phase: callPhaseRef.current
      });
      setCallError(toErrorMessage(error, "Unable to end call cleanly."));
      closePeerConnection();
      stopLocalCallStream();
      stopRemoteCallStream();
      setIncomingCall(null);
      setActiveCall(null);
      callIdRef.current = null;
      setCallPhase("failed");
      scheduleCallOverlayDismiss(1400);
    } finally {
      callActionLockRef.current = false;
      setIsCallActionLoading(false);
    }
  };

  const toggleCallMute = () => {
    setIsCallMuted((previous) => {
      const nextMuted = !previous;
      localCallStreamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = !nextMuted;
      });
      console.info("[VoiceCall] microphone toggled", {
        callId: callIdRef.current,
        muted: nextMuted
      });
      return nextMuted;
    });
  };

  const toggleCallSpeaker = () => {
    setIsCallSpeakerOn((previous) => {
      const nextSpeakerOn = !previous;
      if (remoteAudioRef.current) {
        remoteAudioRef.current.muted = !nextSpeakerOn;
        remoteAudioRef.current.volume = nextSpeakerOn ? 1 : 0;
        if (nextSpeakerOn) {
          void playRemoteAudio();
        }
      }
      console.info("[VoiceCall] speaker toggled", {
        callId: callIdRef.current,
        speakerOn: nextSpeakerOn
      });
      return nextSpeakerOn;
    });
  };

  const loadNotifications = async ({ silent = false } = {}) => {
    if (!silent) {
      setNotificationsLoading(true);
    }
    try {
      const response = await listNotifications({ limit: NOTIFICATIONS_LIMIT });
      setNotifications(Array.isArray(response?.notifications) ? response.notifications : []);
      setNotificationsUnread(Number.isFinite(response?.total_unread) ? response.total_unread : 0);
      setNotificationsError("");
    } catch (error) {
      setNotificationsError(toErrorMessage(error, "Unable to load notifications."));
    } finally {
      if (!silent) {
        setNotificationsLoading(false);
      }
    }
  };

  const mergeRealtimeNotification = (notification) => {
    if (!notification?.id) {
      return;
    }
    setNotifications((previous) => {
      const withoutDuplicate = previous.filter((item) => item.id !== notification.id);
      return [notification, ...withoutDuplicate]
        .sort((first, second) => {
          const firstTime = Date.parse(first.created_at) || 0;
          const secondTime = Date.parse(second.created_at) || 0;
          return secondTime - firstTime || second.id - first.id;
        })
        .slice(0, NOTIFICATIONS_LIMIT);
    });
  };

  const syncAfterRealtimeNotification = (notification) => {
    if (!notification?.type) {
      return;
    }
    const conversationId = notification.related_conversation_id;
    if (conversationId) {
      void refreshConversations();
      if (selectedConversationIdRef.current === conversationId) {
        void loadMessagesForConversation(conversationId, {
          markSeen: false,
          silent: true
        });
      }
    }
    if (
      [
        "new_friend_request",
        "friend_request_accepted",
        "challenge_received",
        "challenge_accepted",
        "challenge_declined"
      ].includes(notification.type)
    ) {
      void loadSocialSnapshot({ silent: true });
    }
    if (["call_incoming", "call_missed", "call_declined", "call_canceled"].includes(notification.type)) {
      void pollCallState();
    }
  };

  const loadSearchResults = async (query) => {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < SEARCH_MIN_CHARS) {
      setSearchResults([]);
      setSearchError("");
      return;
    }

    setIsSearching(true);
    try {
      const results = await searchUsers(normalizedQuery);
      setSearchResults(results);
      setSearchError("");
    } catch (error) {
      setSearchResults([]);
      setSearchError(
        toErrorMessage(error, "Unable to search players right now.", {
          forSocialBootstrap: true
        })
      );
    } finally {
      setIsSearching(false);
    }
  };

  const loadSocialSnapshot = async ({ silent = false } = {}) => {
    if (!silent) {
      setIsLoading(true);
    }
    try {
      const [friendsResult, requestsResult, conversationsResult] = await Promise.allSettled([
        listFriends(),
        listFriendRequests(),
        listConversations()
      ]);

      const errors = [];
      const nextSnapshotErrors = {
        friends: "",
        requests: "",
        conversations: ""
      };

      if (friendsResult.status === "fulfilled") {
        setFriends(Array.isArray(friendsResult.value) ? friendsResult.value : []);
      } else {
        setFriends([]);
        nextSnapshotErrors.friends = toErrorMessage(friendsResult.reason, "Unable to load friends.", {
          forSocialBootstrap: true
        });
        errors.push(nextSnapshotErrors.friends);
      }

      if (requestsResult.status === "fulfilled") {
        setIncomingRequests(
          Array.isArray(requestsResult.value?.incoming) ? requestsResult.value.incoming : []
        );
        setOutgoingRequests(
          Array.isArray(requestsResult.value?.outgoing) ? requestsResult.value.outgoing : []
        );
      } else {
        setIncomingRequests([]);
        setOutgoingRequests([]);
        nextSnapshotErrors.requests = toErrorMessage(
          requestsResult.reason,
          "Unable to load friend requests.",
          {
            forSocialBootstrap: true
          }
        );
        errors.push(nextSnapshotErrors.requests);
      }

      if (conversationsResult.status === "fulfilled") {
        const conversationRows = Array.isArray(conversationsResult.value?.conversations)
          ? conversationsResult.value.conversations
          : [];
        setConversations(conversationRows);
        setTotalUnread(
          Number.isFinite(conversationsResult.value?.total_unread)
            ? conversationsResult.value.total_unread
            : 0
        );
        setSelectedConversationId((previous) => {
          if (previous && conversationRows.some((row) => row.id === previous)) {
            return previous;
          }
          return conversationRows[0]?.id ?? null;
        });
      } else {
        setConversations([]);
        setTotalUnread(0);
        setSelectedConversationId(null);
        nextSnapshotErrors.conversations = toErrorMessage(
          conversationsResult.reason,
          "Unable to load conversations.",
          {
            forSocialBootstrap: true
          }
        );
        errors.push(nextSnapshotErrors.conversations);
      }

      setSnapshotErrors(nextSnapshotErrors);

      if (errors.length) {
        const uniqueErrors = [...new Set(errors)];
        setStatusNote(uniqueErrors[0]);
      } else {
        setStatusNote("");
      }
    } catch (error) {
      setFriends([]);
      setIncomingRequests([]);
      setOutgoingRequests([]);
      setConversations([]);
      setTotalUnread(0);
      setSelectedConversationId(null);
      setSnapshotErrors({
        friends: "",
        requests: "",
        conversations: ""
      });
      setStatusNote(
        toErrorMessage(error, "Unable to load Social Arena.", {
          forSocialBootstrap: true
        })
      );
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  };

  const refreshConversations = async () => {
    setIsRefreshingConversations(true);
    try {
      const response = await listConversations();
      const conversationRows = Array.isArray(response?.conversations) ? response.conversations : [];
      setConversations(conversationRows);
      setTotalUnread(Number.isFinite(response?.total_unread) ? response.total_unread : 0);

      setSelectedConversationId((previous) => {
        if (previous && conversationRows.some((row) => row.id === previous)) {
          return previous;
        }
        return conversationRows[0]?.id ?? null;
      });
      setSnapshotErrors((previous) => ({ ...previous, conversations: "" }));
    } catch (error) {
      setSnapshotErrors((previous) => ({
        ...previous,
        conversations: toErrorMessage(error, "Unable to refresh conversations.", {
          forSocialBootstrap: true
        })
      }));
      setStatusNote(
        toErrorMessage(error, "Unable to refresh conversations.", {
          forSocialBootstrap: true
        })
      );
    } finally {
      setIsRefreshingConversations(false);
    }
  };

  const clearNotificationSocketTimers = () => {
    if (notificationReconnectTimerRef.current) {
      window.clearTimeout(notificationReconnectTimerRef.current);
      notificationReconnectTimerRef.current = 0;
    }
    if (notificationHeartbeatTimerRef.current) {
      window.clearInterval(notificationHeartbeatTimerRef.current);
      notificationHeartbeatTimerRef.current = 0;
    }
  };

  const clearPresenceSocketTimers = () => {
    if (presenceReconnectTimerRef.current) {
      window.clearTimeout(presenceReconnectTimerRef.current);
      presenceReconnectTimerRef.current = 0;
    }
    if (presenceHeartbeatTimerRef.current) {
      window.clearInterval(presenceHeartbeatTimerRef.current);
      presenceHeartbeatTimerRef.current = 0;
    }
  };

  const sendPresenceEvent = (payload) => {
    const socket = presenceSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  };

  const sendTypingStop = () => {
    if (typingStopTimerRef.current) {
      window.clearTimeout(typingStopTimerRef.current);
      typingStopTimerRef.current = 0;
    }
    if (!isTypingSentRef.current) {
      return;
    }
    const conversationId = selectedConversationIdRef.current;
    const typingConversationId = typingConversationIdRef.current ?? conversationId;
    if (typingConversationId) {
      sendPresenceEvent({
        type: "typing_stop",
        conversation_id: typingConversationId
      });
    }
    isTypingSentRef.current = false;
    typingConversationIdRef.current = null;
  };

  const sendTypingStart = () => {
    const conversationId = selectedConversationIdRef.current;
    if (!conversationId || isTypingSentRef.current) {
      return;
    }
    if (
      sendPresenceEvent({
        type: "typing_start",
        conversation_id: conversationId
      })
    ) {
      isTypingSentRef.current = true;
      typingConversationIdRef.current = conversationId;
    }
  };

  const handleMessageDraftChange = (event) => {
    setMessageDraft(event.target.value);
    if (!activeConversation?.can_message || isSendingMessage || isRecordingVoice) {
      return;
    }
    sendTypingStart();
    if (typingStopTimerRef.current) {
      window.clearTimeout(typingStopTimerRef.current);
    }
    typingStopTimerRef.current = window.setTimeout(sendTypingStop, TYPING_STOP_DELAY_MS);
  };

  const setStaleActivityTimer = (conversationId) => {
    const key = String(conversationId);
    if (activityTimersRef.current[key]) {
      window.clearTimeout(activityTimersRef.current[key]);
    }
    activityTimersRef.current[key] = window.setTimeout(() => {
      setConversationActivity((previous) => {
        const next = { ...previous };
        delete next[conversationId];
        return next;
      });
      delete activityTimersRef.current[key];
    }, ACTIVITY_STALE_TIMEOUT_MS);
  };

  const applyConversationActivity = ({ conversationId, userId, type }) => {
    if (!conversationId || !userId || userId === user?.id) {
      return;
    }
    setConversationActivity((previous) => ({
      ...previous,
      [conversationId]: { userId, type, updatedAt: Date.now() }
    }));
    setStaleActivityTimer(conversationId);
  };

  const clearConversationActivity = ({ conversationId, userId, type }) => {
    if (!conversationId) {
      return;
    }
    setConversationActivity((previous) => {
      const current = previous[conversationId];
      if (!current || (userId && current.userId !== userId) || (type && current.type !== type)) {
        return previous;
      }
      const next = { ...previous };
      delete next[conversationId];
      return next;
    });
    const key = String(conversationId);
    if (activityTimersRef.current[key]) {
      window.clearTimeout(activityTimersRef.current[key]);
      delete activityTimersRef.current[key];
    }
  };

  const loadMessagesForConversation = async (conversationId, { markSeen = false, silent = false } = {}) => {
    if (!conversationId) {
      setMessages([]);
      setTimelineItems([]);
      setMessagesError("");
      return;
    }

    if (!silent) {
      setMessagesLoading(true);
      setMessagesError("");
    }

    try {
      const response = await listConversationMessages(conversationId, { limit: MESSAGES_LIMIT });
      const messageRows = Array.isArray(response?.messages) ? response.messages : [];
      const timelineRows =
        Array.isArray(response?.timeline) && response.timeline.length > 0
          ? response.timeline
          : mapMessageTimelineFallback(messageRows);

      setMessages(messageRows);
      setTimelineItems(timelineRows);

      if (response?.conversation) {
        setConversations((previous) =>
          previous.map((conversation) =>
            conversation.id === response.conversation.id ? response.conversation : conversation
          )
        );
      }

      if (markSeen) {
        await markConversationSeen(conversationId);
        await refreshConversations();
      }
    } catch (error) {
      setMessages([]);
      setTimelineItems([]);
      setMessagesError(
        toErrorMessage(error, "Unable to load messages.", {
          forSocialBootstrap: true
        })
      );
    } finally {
      if (!silent) {
        setMessagesLoading(false);
      }
    }
  };

  const loadPresenceForUsers = async (userIds) => {
    try {
      const response = await listPresence(userIds);
      const rows = Array.isArray(response?.users) ? response.users : [];
      setPresenceByUserId((previous) => {
        const next = { ...previous };
        rows.forEach((presence) => {
          next[presence.user_id] = presence;
        });
        return next;
      });
    } catch (error) {
      console.warn("[Presence] initial presence load failed", error);
    }
  };

  useEffect(() => {
    loadSocialSnapshot();
    loadNotifications();
  }, []);

  useEffect(() => {
    const userIds = new Set();
    conversations.forEach((conversation) => {
      if (conversation?.peer?.id) {
        userIds.add(conversation.peer.id);
      }
    });
    friends.forEach((friendship) => {
      if (friendship?.friend?.id) {
        userIds.add(friendship.friend.id);
      }
    });
    if (userIds.size > 0) {
      void loadPresenceForUsers([...userIds]);
    }
  }, [conversations, friends]);

  useEffect(() => {
    if (!user?.id) {
      return undefined;
    }

    let isDisposed = false;

    const closeSocket = () => {
      clearNotificationSocketTimers();
      if (notificationSocketRef.current) {
        notificationSocketRef.current.onopen = null;
        notificationSocketRef.current.onclose = null;
        notificationSocketRef.current.onerror = null;
        notificationSocketRef.current.onmessage = null;
        notificationSocketRef.current.close();
        notificationSocketRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (isDisposed || notificationReconnectTimerRef.current) {
        return;
      }
      notificationReconnectTimerRef.current = window.setTimeout(() => {
        notificationReconnectTimerRef.current = 0;
        connectSocket();
      }, NOTIFICATION_SOCKET_RECONNECT_MS);
    };

    const connectSocket = () => {
      closeSocket();
      const socket = createNotificationsSocket();
      if (!socket) {
        setNotificationSocketState("unavailable");
        return;
      }
      notificationSocketRef.current = socket;
      setNotificationSocketState("connecting");

      socket.onopen = () => {
        setNotificationSocketState("live");
        void loadNotifications({ silent: true });
        notificationHeartbeatTimerRef.current = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "heartbeat" }));
          }
        }, NOTIFICATION_SOCKET_HEARTBEAT_MS);
      };

      socket.onmessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (payload?.type === "notification" && payload.notification) {
          mergeRealtimeNotification(payload.notification);
          if (Number.isFinite(payload.unread_count)) {
            setNotificationsUnread(payload.unread_count);
          } else if (!payload.notification.is_read) {
            setNotificationsUnread((previous) => previous + 1);
          }
          syncAfterRealtimeNotification(payload.notification);
          return;
        }
        if (payload?.type === "unread_count" && Number.isFinite(payload.unread_count)) {
          setNotificationsUnread(payload.unread_count);
        }
      };

      socket.onerror = () => {
        setNotificationSocketState("reconnecting");
      };

      socket.onclose = () => {
        clearNotificationSocketTimers();
        if (!isDisposed) {
          setNotificationSocketState("reconnecting");
          scheduleReconnect();
        }
      };
    };

    connectSocket();
    return () => {
      isDisposed = true;
      sendTypingStop();
      closeSocket();
      Object.values(activityTimersRef.current).forEach((timerId) => {
        window.clearTimeout(timerId);
      });
      activityTimersRef.current = {};
      setConversationActivity({});
    };
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) {
      return undefined;
    }

    let isDisposed = false;

    const closeSocket = () => {
      clearPresenceSocketTimers();
      if (presenceSocketRef.current) {
        presenceSocketRef.current.onopen = null;
        presenceSocketRef.current.onclose = null;
        presenceSocketRef.current.onerror = null;
        presenceSocketRef.current.onmessage = null;
        presenceSocketRef.current.close();
        presenceSocketRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (isDisposed || presenceReconnectTimerRef.current) {
        return;
      }
      presenceReconnectTimerRef.current = window.setTimeout(() => {
        presenceReconnectTimerRef.current = 0;
        connectSocket();
      }, PRESENCE_SOCKET_RECONNECT_MS);
    };

    const connectSocket = () => {
      closeSocket();
      const socket = createPresenceSocket();
      if (!socket) {
        setPresenceSocketState("unavailable");
        return;
      }
      presenceSocketRef.current = socket;
      setPresenceSocketState("connecting");

      socket.onopen = () => {
        setPresenceSocketState("live");
        presenceHeartbeatTimerRef.current = window.setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "heartbeat" }));
          }
        }, PRESENCE_SOCKET_HEARTBEAT_MS);
      };

      socket.onmessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (payload?.type === "presence_update" && payload.presence) {
          setPresenceByUserId((previous) => ({
            ...previous,
            [payload.presence.user_id]: payload.presence
          }));
          return;
        }
        if (payload?.type === "typing_start") {
          applyConversationActivity({
            conversationId: payload.conversation_id,
            userId: payload.user_id,
            type: "typing"
          });
          return;
        }
        if (payload?.type === "typing_stop") {
          clearConversationActivity({
            conversationId: payload.conversation_id,
            userId: payload.user_id,
            type: "typing"
          });
          return;
        }
        if (payload?.type === "recording_start") {
          applyConversationActivity({
            conversationId: payload.conversation_id,
            userId: payload.user_id,
            type: "recording"
          });
          return;
        }
        if (payload?.type === "recording_stop") {
          clearConversationActivity({
            conversationId: payload.conversation_id,
            userId: payload.user_id,
            type: "recording"
          });
        }
      };

      socket.onerror = () => {
        setPresenceSocketState("reconnecting");
      };

      socket.onclose = () => {
        clearPresenceSocketTimers();
        if (!isDisposed) {
          setPresenceSocketState("reconnecting");
          scheduleReconnect();
        }
      };
    };

    connectSocket();
    return () => {
      isDisposed = true;
      closeSocket();
    };
  }, [user?.id]);

  useEffect(() => {
    sendTypingStop();
    if (!selectedConversationId) {
      setMessages([]);
      setTimelineItems([]);
      setMessagesError("");
      return;
    }
    loadMessagesForConversation(selectedConversationId, { markSeen: true });
  }, [selectedConversationId]);

  useEffect(() => {
    if (searchQuery.trim().length < SEARCH_MIN_CHARS) {
      setSearchResults([]);
      setSearchError("");
      setIsSearching(false);
      return;
    }

    const timer = window.setTimeout(() => {
      loadSearchResults(searchQuery);
    }, 280);

    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      refreshConversations();
      loadNotifications({ silent: true });
      if (selectedConversationId) {
        loadMessagesForConversation(selectedConversationId, { markSeen: false, silent: true });
      }
    }, POLLING_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [selectedConversationId]);

  useEffect(() => {
    void pollCallState();
    const intervalId = window.setInterval(() => {
      void pollCallState();
    }, CALL_SIGNAL_POLLING_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [selectedConversationId]);

  useEffect(() => {
    const releaseCallResources = () => {
      const currentCallId = callIdRef.current;
      if (currentCallId && !CALL_TERMINAL_PHASES.has(callPhaseRef.current)) {
        void endCall(currentCallId).catch((error) => {
          console.warn("[VoiceCall] failed to notify call end during page unload", error);
        });
      }
      clearCallDismissTimer();
      clearCallReconnectTimer();
      closePeerConnection();
      stopLocalCallStream();
      stopRemoteCallStream();
    };

    window.addEventListener("pagehide", releaseCallResources);
    window.addEventListener("beforeunload", releaseCallResources);
    return () => {
      window.removeEventListener("pagehide", releaseCallResources);
      window.removeEventListener("beforeunload", releaseCallResources);
      releaseCallResources();
    };
  }, []);

  useEffect(() => {
    if (!isCallLive || !activeCall) {
      if (isCallTerminal && Number.isFinite(activeCall?.duration_seconds)) {
        setCallDurationSeconds(activeCall.duration_seconds);
      }
      return undefined;
    }

    const connectedAtMs = activeCall.connected_at ? Date.parse(activeCall.connected_at) : Date.now();
    const tick = () => {
      const elapsed = Math.max(0, Math.floor((Date.now() - connectedAtMs) / 1000));
      setCallDurationSeconds(elapsed);
    };
    tick();
    const timerId = window.setInterval(tick, 1000);
    return () => window.clearInterval(timerId);
  }, [activeCall, isCallLive, isCallTerminal]);

  useEffect(() => {
    if (!localCallStreamRef.current) {
      return;
    }
    localCallStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !isCallMuted;
    });
  }, [isCallMuted]);

  useEffect(() => {
    if (!remoteAudioRef.current) {
      return;
    }
    remoteAudioRef.current.muted = !isCallSpeakerOn;
    remoteAudioRef.current.volume = isCallSpeakerOn ? 1 : 0;
    if (isCallSpeakerOn) {
      void playRemoteAudio();
    }
  }, [isCallSpeakerOn]);

  useEffect(() => {
    if (!messageListRef.current) {
      return;
    }
    messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
  }, [timelineItems, selectedConversationId]);

  useEffect(() => {
    if (!isNotificationsOpen) {
      return;
    }

    const handlePointerDown = (event) => {
      if (
        notificationsPanelRef.current &&
        !notificationsPanelRef.current.contains(event.target)
      ) {
        setIsNotificationsOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isNotificationsOpen]);

  useEffect(() => {
    if (!isChallengeComposerOpen) {
      return;
    }
    const handleEscape = (event) => {
      if (event.key === "Escape" && !challengeSubmitting) {
        setIsChallengeComposerOpen(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [challengeSubmitting, isChallengeComposerOpen]);

  useEffect(
    () => () => {
      stopVoiceRecording({ discard: true });
      stopRecordingStreamTracks();
      clearVoiceDraft();
      clearRecordingInterval();
      clearCallDismissTimer();
      const currentCallId = callIdRef.current;
      const currentCallStatus = normalizeCallStatus(activeCallRef.current?.status);
      if (currentCallId && !CALL_TERMINAL_STATUSES.has(currentCallStatus)) {
        void endCall(currentCallId).catch(() => {
          // Best-effort close for route changes or refresh.
        });
      }
      closePeerConnection();
      stopLocalCallStream();
      stopRemoteCallStream();
    },
    []
  );

  useEffect(() => {
    setVoiceComposerError("");
    if (isRecordingVoice) {
      stopVoiceRecording({ discard: true });
    } else {
      clearVoiceDraft();
    }
    stopRecordingStreamTracks();
  }, [selectedConversationId]);

  const refreshAfterAction = async ({ rerunSearch = true } = {}) => {
    await Promise.all([loadSocialSnapshot({ silent: true }), loadNotifications({ silent: true })]);
    if (selectedConversationId) {
      await loadMessagesForConversation(selectedConversationId, {
        markSeen: false,
        silent: true
      });
    }
    if (rerunSearch && searchQuery.trim().length >= SEARCH_MIN_CHARS) {
      await loadSearchResults(searchQuery);
    }
  };

  const performAction = async (loadingKey, action, successNote) => {
    setActionLoadingKey(loadingKey);
    try {
      await action();
      if (successNote) {
        setStatusNote(successNote);
      }
      await refreshAfterAction();
    } catch (error) {
      setStatusNote(
        toErrorMessage(error, "Action failed. Please try again.", {
          forSocialBootstrap: true
        })
      );
    } finally {
      setActionLoadingKey("");
    }
  };

  const handleStartConversation = async (friendId) => {
    setActionLoadingKey(`start-chat-${friendId}`);
    try {
      const conversation = await createOrGetDirectConversation(friendId);
      await refreshConversations();
      setSelectedConversationId(conversation.id);
      setStatusNote("Conversation ready.");
    } catch (error) {
      setStatusNote(
        toErrorMessage(error, "Unable to open conversation.", {
          forSocialBootstrap: true
        })
      );
    } finally {
      setActionLoadingKey("");
    }
  };

  const handleSendMessage = async (event) => {
    event.preventDefault();
    if (
      !selectedConversationId ||
      !activeConversation?.can_message ||
      isSendingMessage ||
      isRecordingVoice ||
      isUploadingVoice ||
      recordedVoiceBlob
    ) {
      return;
    }

    const body = messageDraft.trim();
    if (!body) {
      return;
    }

    setIsSendingMessage(true);
    sendTypingStop();
    try {
      await sendConversationMessage(selectedConversationId, body);
      setMessageDraft("");
      await loadMessagesForConversation(selectedConversationId, { markSeen: false, silent: true });
      await Promise.all([refreshConversations(), loadNotifications({ silent: true })]);
    } catch (error) {
      setMessagesError(
        toErrorMessage(error, "Unable to send message.", {
          forSocialBootstrap: true
        })
      );
    } finally {
      setIsSendingMessage(false);
    }
  };

  const handleChallengeSubmit = async (event) => {
    event.preventDefault();
    if (!selectedConversationId || challengeSubmitting) {
      return;
    }

    const title = challengeForm.title.trim();
    if (!title) {
      setChallengeError("Challenge title is required.");
      return;
    }

    setChallengeSubmitting(true);
    setChallengeError("");
    try {
      await createConversationChallenge(selectedConversationId, {
        title,
        category: challengeForm.category || null,
        difficulty: challengeForm.difficulty || null,
        expires_in_minutes: Number(challengeForm.expiresInMinutes) || null
      });

      setIsChallengeComposerOpen(false);
      setStatusNote("Challenge sent.");
      await Promise.all([
        loadMessagesForConversation(selectedConversationId, { markSeen: false, silent: true }),
        refreshConversations(),
        loadNotifications({ silent: true })
      ]);
    } catch (error) {
      setChallengeError(toErrorMessage(error, "Unable to create challenge."));
    } finally {
      setChallengeSubmitting(false);
    }
  };

  const handleChallengeAction = async (challengeId, actionType) => {
    const actionKey = `${actionType}-${challengeId}`;
    setChallengeActionLoadingKey(actionKey);
    try {
      if (actionType === "accept") {
        await acceptChallenge(challengeId);
        setStatusNote("Challenge accepted.");
      } else if (actionType === "decline") {
        await declineChallenge(challengeId);
        setStatusNote("Challenge declined.");
      } else if (actionType === "cancel") {
        await cancelChallenge(challengeId);
        setStatusNote("Challenge canceled.");
      }

      if (selectedConversationId) {
        await loadMessagesForConversation(selectedConversationId, {
          markSeen: false,
          silent: true
        });
      }
      await Promise.all([refreshConversations(), loadNotifications({ silent: true })]);
    } catch (error) {
      setStatusNote(toErrorMessage(error, "Unable to update challenge."));
    } finally {
      setChallengeActionLoadingKey("");
    }
  };

  const handleNotificationOpenThread = async (notification) => {
    if (notification?.related_conversation_id) {
      setSelectedConversationId(notification.related_conversation_id);
      await loadMessagesForConversation(notification.related_conversation_id, {
        markSeen: notification.type === "new_message" || notification.type === "new_voice_message",
        silent: true
      });
      setIsNotificationsOpen(false);
    } else if (
      ["new_friend_request", "friend_request_accepted"].includes(notification?.type)
    ) {
      await loadSocialSnapshot({ silent: true });
      setIsNotificationsOpen(false);
    } else if (notification?.related_challenge_id) {
      await loadSocialSnapshot({ silent: true });
      setIsNotificationsOpen(false);
    }
    if (!notification?.is_read) {
      await handleNotificationRead(notification.id, { silent: true });
    }
  };

  const handleNotificationRead = async (notificationId, { silent = false } = {}) => {
    const actionKey = `notification-read-${notificationId}`;
    setNotificationActionLoadingKey(actionKey);
    try {
      await markNotificationRead(notificationId);
      setNotifications((previous) =>
        previous.map((notification) =>
          notification.id === notificationId ? { ...notification, is_read: true } : notification
        )
      );
      setNotificationsUnread((previous) => Math.max(0, previous - 1));
      if (!silent) {
        setStatusNote("Notification marked as read.");
      }
      await loadNotifications({ silent: true });
    } catch (error) {
      setStatusNote(toErrorMessage(error, "Unable to update notification."));
    } finally {
      setNotificationActionLoadingKey("");
    }
  };

  const handleMarkAllNotificationsRead = async () => {
    const actionKey = "notifications-read-all";
    setNotificationActionLoadingKey(actionKey);
    try {
      await markAllNotificationsRead();
      setNotifications((previous) =>
        previous.map((notification) => ({ ...notification, is_read: true }))
      );
      setNotificationsUnread(0);
      setStatusNote("All notifications marked as read.");
      await loadNotifications({ silent: true });
    } catch (error) {
      setStatusNote(toErrorMessage(error, "Unable to mark all notifications."));
    } finally {
      setNotificationActionLoadingKey("");
    }
  };

  const handleChatAction = (actionType) => {
    if (actionType === "call") {
      if (!activeConversation?.can_message) {
        setStatusNote("Voice call is available only for active friends.");
        return;
      }
      if (isCallActionLoading) {
        return;
      }
      if (isCallLive && activeCall?.conversation_id !== activeConversation?.id) {
        setStatusNote("You already have an active call in another thread.");
        return;
      }
      if (activePeerUnavailableForCall) {
        setStatusNote(`${displayNameForUser(activePeer, "This player")} is already in a call.`);
        return;
      }
      void handleStartVoiceCall();
      return;
    }
    if (actionType === "challenge") {
      if (!activeConversation?.can_message) {
        setStatusNote("Challenge is available only for active friends.");
        return;
      }
      setChallengeError("");
      setIsChallengeComposerOpen(true);
      return;
    }
    if (actionType === "share") {
      setStatusNote("Result sharing is being prepared.");
      return;
    }
    if (actionType === "profile" && activePeer?.username) {
      navigate("/profile");
      return;
    }
  };

  if (isLoading) {
    return (
      <main className="page-shell social-page">
        <section className="social-shell">
          <header className="social-header social-skeleton-surface">
            <div className="social-header-main">
              <div className="social-skeleton-line is-chip" />
              <div className="social-skeleton-line is-hero" />
              <div className="social-skeleton-line is-wide" />
              <div className="social-header-metrics">
                <article className="social-skeleton-metric" />
                <article className="social-skeleton-metric" />
                <article className="social-skeleton-metric" />
              </div>
            </div>
            <div className="social-header-actions">
              <div className="social-skeleton-line is-button" />
              <div className="social-skeleton-line is-button" />
            </div>
          </header>
          <section className="social-layout">
            <aside className="feature-card social-sidebar">
              <SocialSectionSkeleton rows={4} />
            </aside>
            <section className="feature-card social-chat">
              <SocialSectionSkeleton rows={5} />
            </section>
            <aside className="feature-card social-side-info">
              <SocialSectionSkeleton rows={3} />
            </aside>
          </section>
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell social-page">
      <section className="social-shell">
        <header className="social-header">
          <div className="social-header-main">
            <div className="social-header-kicker-row">
              <span className="brand-mark">English Lemon</span>
              <span className="social-header-chip is-live">Live Arena</span>
              <span className="social-header-chip">{onlineFriendCount} friends online</span>
            </div>
            <h1>Social Arena</h1>
            <p className="dashboard-subtitle">
              Build your squad, keep messages flowing, and launch head-to-head English challenges.
            </p>
            <div className="social-header-metrics">
              <article>
                <strong>{conversations.length}</strong>
                <span>Active Threads</span>
              </article>
              <article>
                <strong>{challengeSummary.pendingCount}</strong>
                <span>Pending Challenges</span>
              </article>
              <article>
                <strong>{socialMomentum}</strong>
                <span>Social Momentum</span>
              </article>
            </div>
          </div>

          <div className="social-header-actions">
            <div className="social-notifications" ref={notificationsPanelRef}>
              <button
                type="button"
                className={`secondary-btn social-notification-trigger ${isNotificationsOpen ? "is-active" : ""}`}
                onClick={() => setIsNotificationsOpen((current) => !current)}
              >
                Notifications
                {notificationsUnread > 0 ? (
                  <span className="social-notification-badge">{notificationsUnread}</span>
                ) : null}
              </button>

              {isNotificationsOpen ? (
                <div className="social-notification-panel">
                  <div className="social-notification-head">
                    <div>
                      <h3>Notifications</h3>
                      <span className={`social-notification-live is-${notificationSocketState}`}>
                        {notificationSocketState === "live"
                          ? "Live"
                          : notificationSocketState === "reconnecting"
                            ? "Reconnecting"
                            : "Syncing"}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="secondary-btn social-mini-btn"
                      onClick={handleMarkAllNotificationsRead}
                      disabled={
                        notificationsUnread === 0 ||
                        notificationActionLoadingKey === "notifications-read-all"
                      }
                    >
                      {notificationActionLoadingKey === "notifications-read-all"
                        ? "Marking..."
                        : "Mark All Read"}
                    </button>
                  </div>

                  {notificationsLoading ? <SocialSectionSkeleton rows={3} /> : null}
                  {notificationsError ? <p className="error-text">{notificationsError}</p> : null}
                  {!notificationsLoading && !notificationsError && notifications.length === 0 ? (
                    <SocialSectionState
                      badge="Live Feed"
                      title="No notifications yet"
                      description="Friend requests, new messages, call events, and challenge updates will show up here in real time."
                    />
                  ) : null}

                  <div className="social-notification-list">
                    {notifications.map((notification) => {
                      const typeMeta = getNotificationTypeMeta(notification.type);
                      const canOpen = Boolean(
                        notification.related_conversation_id ||
                          notification.related_challenge_id ||
                          ["new_friend_request", "friend_request_accepted"].includes(notification.type)
                      );
                      return (
                        <article
                          key={notification.id}
                          className={`social-notification-item ${notification.is_read ? "" : "is-unread"} is-${typeMeta.accent}`}
                        >
                          <span className="social-notification-icon" aria-hidden="true">
                            {typeMeta.icon}
                          </span>
                          <div className="social-notification-copy">
                            <div className="social-notification-title-row">
                              <p className="social-item-title">{notification.title}</p>
                              <span>{typeMeta.label}</span>
                            </div>
                            <p className="social-item-subtitle">{notification.body}</p>
                            <p className="social-item-subtitle">
                              {formatRelativeTime(notification.created_at)}
                            </p>
                          </div>
                          <div className="social-notification-actions">
                            {canOpen ? (
                              <button
                                type="button"
                                className="secondary-btn social-mini-btn"
                                onClick={() => handleNotificationOpenThread(notification)}
                              >
                                Open
                              </button>
                            ) : null}
                            {!notification.is_read ? (
                              <button
                                type="button"
                                className="secondary-btn social-mini-btn"
                                onClick={() => handleNotificationRead(notification.id)}
                                disabled={
                                  notificationActionLoadingKey ===
                                  `notification-read-${notification.id}`
                                }
                              >
                                {notificationActionLoadingKey ===
                                `notification-read-${notification.id}`
                                  ? "Saving..."
                                  : "Read"}
                              </button>
                            ) : null}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </div>
              ) : null}
            </div>

            <span className={`social-unread-pill ${totalUnread > 0 ? "has-unread" : ""}`}>
              {totalUnread > 0 ? `${totalUnread} unread` : "Inbox clear"}
            </span>
            <button
              type="button"
              className="secondary-btn social-back-btn"
              onClick={() => navigate("/dashboard")}
            >
              Back to Dashboard
            </button>
          </div>
        </header>

        {statusNote ? <p className={statusNoteClassName}>{statusNote}</p> : null}

        <section className="social-layout">
          <aside className="feature-card social-sidebar">
            <section className="social-section">
              <div className="social-section-head">
                <h2>Find Players</h2>
                <span>Network</span>
              </div>

              <div className="social-search-wrap">
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search username or email"
                  className="social-search-input"
                />
              </div>

              {searchError ? <p className="error-text">{searchError}</p> : null}
              {isSearching ? <SocialSectionSkeleton rows={2} /> : null}

              <div className="social-list">
                {searchResults.map((result) => {
                  const relationshipMeta =
                    RELATIONSHIP_META[result.relationship_status] ?? RELATIONSHIP_META.none;
                  const isSearchActionLoading =
                    actionLoadingKey === `search-${result.user.id}` ||
                    actionLoadingKey === `start-chat-${result.user.id}`;

                  return (
                    <article key={result.user.id} className="social-list-item social-user-item">
                      <div className="social-item-main">
                        <span className="social-avatar-chip social-avatar-chip-sm">
                          {initialsForUser(result.user)}
                        </span>
                        <div className="social-item-copy">
                          <div className="social-item-title-row">
                            <p className="social-item-title">{displayNameForUser(result.user)}</p>
                            <span className={`social-inline-badge ${relationshipMeta.className}`}>
                              {relationshipMeta.label}
                            </span>
                          </div>
                          <p className="social-item-subtitle">{identityLineForUser(result.user)}</p>
                        </div>
                      </div>

                      <div className="social-item-actions">
                        {result.relationship_status === "friend" ? (
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() => handleStartConversation(result.user.id)}
                            disabled={isSearchActionLoading}
                          >
                            Message
                          </button>
                        ) : null}
                        {result.relationship_status === "none" ? (
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() =>
                              performAction(
                                `search-${result.user.id}`,
                                () => sendFriendRequest(result.user.id),
                                "Friend request sent."
                              )
                            }
                            disabled={isSearchActionLoading}
                          >
                            Add Friend
                          </button>
                        ) : null}
                        {result.relationship_status === "incoming_request" && result.request_id ? (
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() =>
                              performAction(
                                `search-${result.user.id}`,
                                () => acceptFriendRequest(result.request_id),
                                "Friend request accepted."
                              )
                            }
                            disabled={isSearchActionLoading}
                          >
                            Accept
                          </button>
                        ) : null}
                        {result.relationship_status === "outgoing_request" && result.request_id ? (
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() =>
                              performAction(
                                `search-${result.user.id}`,
                                () => cancelFriendRequest(result.request_id),
                                "Friend request canceled."
                              )
                            }
                            disabled={isSearchActionLoading}
                          >
                            Cancel Request
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}

                {!isSearching && !searchError && searchQuery.trim().length < SEARCH_MIN_CHARS ? (
                  <SocialSectionState
                    badge="Search"
                    title="Find your next study partner"
                    description="Search by username or email to send a friend request and start a direct conversation."
                  />
                ) : null}

                {!isSearching &&
                !searchError &&
                searchQuery.trim().length >= SEARCH_MIN_CHARS &&
                searchResults.length === 0 ? (
                  <SocialSectionState
                    badge="No Results"
                    title="No players matched that search"
                    description="Try another username or email. If you are testing locally, create a second account to see friend search in action."
                  />
                ) : null}
              </div>
            </section>

            <section className="social-section">
              <div className="social-section-head">
                <h2>Incoming Requests</h2>
                <span>{incomingRequests.length}</span>
              </div>
              {snapshotErrors.requests ? <p className="error-text">{snapshotErrors.requests}</p> : null}
              <div className="social-list">
                {incomingRequests.map((request) => (
                  <article key={request.id} className="social-list-item">
                    <div className="social-item-main">
                      <span className="social-avatar-chip social-avatar-chip-sm">
                        {initialsForUser(request.sender)}
                      </span>
                      <div className="social-item-copy">
                        <p className="social-item-title">{displayNameForUser(request.sender)}</p>
                        <p className="social-item-subtitle">{identityLineForUser(request.sender)}</p>
                      </div>
                    </div>
                    <div className="social-item-actions">
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() =>
                          performAction(
                            `incoming-accept-${request.id}`,
                            () => acceptFriendRequest(request.id),
                            "Friend request accepted."
                          )
                        }
                        disabled={actionLoadingKey === `incoming-accept-${request.id}`}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() =>
                          performAction(
                            `incoming-decline-${request.id}`,
                            () => declineFriendRequest(request.id),
                            "Friend request declined."
                          )
                        }
                        disabled={actionLoadingKey === `incoming-decline-${request.id}`}
                      >
                        Reject
                      </button>
                    </div>
                  </article>
                ))}
                {!snapshotErrors.requests && incomingRequests.length === 0 ? (
                  <SocialSectionState
                    badge="Inbox Clear"
                    title="No incoming requests yet"
                    description="New friend invites will show up here the moment someone reaches out."
                  />
                ) : null}
              </div>
            </section>

            <section className="social-section">
              <div className="social-section-head">
                <h2>Outgoing Requests</h2>
                <span>{outgoingRequests.length}</span>
              </div>
              {snapshotErrors.requests ? <p className="error-text">{snapshotErrors.requests}</p> : null}
              <div className="social-list">
                {outgoingRequests.map((request) => (
                  <article key={request.id} className="social-list-item">
                    <div className="social-item-main">
                      <span className="social-avatar-chip social-avatar-chip-sm">
                        {initialsForUser(request.receiver)}
                      </span>
                      <div className="social-item-copy">
                        <p className="social-item-title">{displayNameForUser(request.receiver)}</p>
                        <p className="social-item-subtitle">{identityLineForUser(request.receiver)}</p>
                      </div>
                    </div>
                    <div className="social-item-actions">
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() =>
                          performAction(
                            `outgoing-cancel-${request.id}`,
                            () => cancelFriendRequest(request.id),
                            "Friend request canceled."
                          )
                        }
                        disabled={actionLoadingKey === `outgoing-cancel-${request.id}`}
                      >
                        Cancel Request
                      </button>
                    </div>
                  </article>
                ))}
                {!snapshotErrors.requests && outgoingRequests.length === 0 ? (
                  <SocialSectionState
                    badge="Pending"
                    title="No outgoing requests"
                    description="When you invite someone, the pending request will stay here until they respond."
                  />
                ) : null}
              </div>
            </section>

            <section className="social-section">
              <div className="social-section-head">
                <h2>Friends</h2>
                <span>{friends.length}</span>
              </div>
              {snapshotErrors.friends ? <p className="error-text">{snapshotErrors.friends}</p> : null}
              <div className="social-list">
                {friends.map((friendship) => (
                  <article key={friendship.id} className="social-list-item">
                    <div className="social-item-main">
                      <span className="social-avatar-chip social-avatar-chip-sm">
                        {initialsForUser(friendship.friend)}
                      </span>
                      <div className="social-item-copy">
                        <p className="social-item-title">{displayNameForUser(friendship.friend)}</p>
                        <p className="social-item-subtitle">
                          {identityLineForUser(friendship.friend)} · Friends since {formatShortDate(friendship.created_at)}
                        </p>
                      </div>
                    </div>
                    <div className="social-item-actions">
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => handleStartConversation(friendship.friend?.id)}
                        disabled={!friendship.friend?.id || actionLoadingKey === `start-chat-${friendship.friend.id}`}
                      >
                        Message
                      </button>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() =>
                          performAction(
                            `friend-remove-${friendship.id}`,
                            () => removeFriend(friendship.friend?.id),
                            "Friend removed."
                          )
                        }
                        disabled={!friendship.friend?.id || actionLoadingKey === `friend-remove-${friendship.id}`}
                      >
                        Remove
                      </button>
                    </div>
                  </article>
                ))}
                {!snapshotErrors.friends && friends.length === 0 ? (
                  <SocialSectionState
                    badge="Friends"
                    title="No friends yet"
                    description="Start with player search, send an invite, and your friend list will turn into your Social Arena roster."
                  />
                ) : null}
              </div>
            </section>

            <section className="social-section">
              <div className="social-section-head">
                <h2>Conversations</h2>
                {isRefreshingConversations ? <span>Syncing...</span> : <span>{conversations.length}</span>}
              </div>
              {snapshotErrors.conversations ? <p className="error-text">{snapshotErrors.conversations}</p> : null}
              <div className="social-list social-conversation-list">
                {conversations.map((conversation) => {
                  const peerPresence = conversation?.peer?.id
                    ? presenceByUserId[conversation.peer.id]
                    : null;
                  const activity = conversationActivity[conversation.id];
                  const presenceLabel =
                    activity?.type === "typing"
                      ? "typing..."
                      : activity?.type === "recording"
                        ? "recording voice..."
                        : formatPresenceLabel(peerPresence);
                  return (
                    <button
                      key={conversation.id}
                      type="button"
                      className={`social-conversation-item ${
                        selectedConversationId === conversation.id ? "is-active" : ""
                      }`}
                      onClick={() => {
                        sendTypingStop();
                        setSelectedConversationId(conversation.id);
                      }}
                    >
                      <div className="social-conversation-main">
                        <span className="social-avatar-chip social-avatar-chip-sm">
                          {initialsForUser(conversation.peer)}
                          <span
                            className={`social-presence-dot ${
                              peerPresence?.in_call
                                ? "is-call"
                                : peerPresence?.is_online
                                  ? "is-online"
                                  : ""
                            }`}
                          />
                        </span>
                        <div className="social-conversation-copy">
                          <div className="social-conversation-title-row">
                            <p className="social-item-title">
                              {displayNameForUser(conversation.peer)}
                            </p>
                            <p className="social-item-subtitle">
                              {identityLineForUser(conversation.peer)}
                            </p>
                          </div>
                          <p
                            className={`social-conversation-status ${
                              activity ? "is-active" : ""
                            }`}
                          >
                            {presenceLabel}
                          </p>
                          <p className="social-conversation-preview">
                            {conversation.last_message?.body ?? "No messages yet"}
                          </p>
                        </div>
                      </div>
                      <div className="social-conversation-meta">
                        <span className="social-item-subtitle">
                          {formatRelativeTime(
                            conversation.last_message?.created_at ?? conversation.updated_at
                          )}
                        </span>
                        {conversation.unread_count > 0 ? (
                          <span className="social-unread-badge">{conversation.unread_count}</span>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
                {!snapshotErrors.conversations && conversations.length === 0 ? (
                  <SocialSectionState
                    badge="DMs"
                    title="No conversations yet"
                    description="Once you message a friend, their latest thread will appear here with unread counts and live activity."
                  />
                ) : null}
              </div>
            </section>
          </aside>

          <section className="feature-card social-chat">
            {activeConversation ? (
              <>
                <header className="social-chat-header">
                  <div className="social-chat-peer">
                    <span className="social-avatar-chip social-avatar-chip-lg">
                      {initialsForUser(activePeer)}
                      <span
                        className={`social-presence-dot ${
                          activePeerPresence?.in_call
                            ? "is-call"
                            : activePeerPresence?.is_online
                              ? "is-online"
                              : ""
                        }`}
                      />
                    </span>
                    <div className="social-chat-peer-copy">
                      <div className="social-chat-peer-top">
                        <h2>{displayNameForUser(activePeer, "Conversation")}</h2>
                        <span
                          className={`social-inline-badge ${
                            activeConversation.can_message ? "is-friend" : "is-muted"
                          }`}
                        >
                          {activeConversation.can_message ? "Friends" : "Not friends"}
                        </span>
                      </div>
                      <p
                        className={`subtle-text social-presence-line ${
                          activeConversationActivity ? "is-active" : ""
                        }`}
                      >
                        {identityLineForUser(activePeer)} | {activePeerStatusLabel}
                        {activeConversationActivity ? (
                          <span className="social-typing-dots" aria-hidden="true">
                            <span />
                            <span />
                            <span />
                          </span>
                        ) : null}
                      </p>
                    </div>
                  </div>

                  <div className="social-chat-header-actions">
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => handleChatAction("call")}
                      disabled={
                        isCallActionLoading ||
                        activePeerUnavailableForCall ||
                        (!activeConversation.can_message &&
                          !(isCallLive && activeCall?.conversation_id === activeConversation.id))
                      }
                    >
                      <IconPhone />
                      {isCallLive && activeCall?.conversation_id === activeConversation.id
                        ? "Return to Call"
                        : activePeerUnavailableForCall
                          ? "In Call"
                        : isCallActionLoading && callPhase === "starting"
                          ? "Starting..."
                          : "Voice Call"}
                    </button>
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => handleChatAction("challenge")}
                    >
                      Challenge
                    </button>
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => handleChatAction("share")}
                    >
                      Share Result
                    </button>
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => handleChatAction("profile")}
                    >
                      View Profile
                    </button>
                  </div>
                </header>

                <div className="social-chat-messages" ref={messageListRef}>
                  {messagesLoading ? <SocialSectionSkeleton rows={4} /> : null}
                  {messagesError ? <p className="error-text">{messagesError}</p> : null}
                  {!messagesLoading && timelineItems.length === 0 ? (
                    <SocialSectionState
                      badge="New Thread"
                      title="No messages yet"
                      description="Break the ice with a message, voice note, or challenge to get this conversation moving."
                    />
                  ) : null}

                  {timelineItems.map((item) => {
                    if (item.kind === "challenge" && item.challenge) {
                      const challenge = item.challenge;
                      const challengeMeta = getChallengeStatusMeta(challenge);
                      const challengeIsMine = challenge.challenger?.id === user?.id;
                      const isChallengeLoading = [
                        `accept-${challenge.id}`,
                        `decline-${challenge.id}`,
                        `cancel-${challenge.id}`
                      ].includes(challengeActionLoadingKey);

                      return (
                        <article
                          key={item.id}
                          className={`social-challenge-card ${
                            challengeIsMine ? "is-mine" : "is-peer"
                          } ${challengeMeta.className}`}
                        >
                          <header className="social-challenge-head">
                            <p className="social-item-title">{challenge.title}</p>
                            <span className={`social-inline-badge ${challengeMeta.className}`}>
                              {challengeMeta.label}
                            </span>
                          </header>
                          <p className="social-item-subtitle">
                            {displayNameForUser(challenge.challenger)} challenged{" "}
                            {displayNameForUser(challenge.challenged)}
                          </p>
                          <div className="social-challenge-meta">
                            {challenge.category ? <span>{challenge.category}</span> : null}
                            {challenge.difficulty ? <span>{challenge.difficulty}</span> : null}
                            {challenge.expires_at ? (
                              <span>Expires {formatDateLabel(challenge.expires_at)}</span>
                            ) : null}
                            <span>Created {formatDateLabel(challenge.created_at)}</span>
                          </div>
                          {challenge.result_summary ? (
                            <p className="social-item-subtitle">{challenge.result_summary}</p>
                          ) : null}

                          {challenge.is_actionable_by_current ? (
                            <div className="social-challenge-actions">
                              {challenge.can_accept ? (
                                <button
                                  type="button"
                                  className="secondary-btn"
                                  onClick={() => handleChallengeAction(challenge.id, "accept")}
                                  disabled={isChallengeLoading}
                                >
                                  {challengeActionLoadingKey === `accept-${challenge.id}`
                                    ? "Accepting..."
                                    : "Accept"}
                                </button>
                              ) : null}
                              {challenge.can_decline ? (
                                <button
                                  type="button"
                                  className="secondary-btn"
                                  onClick={() => handleChallengeAction(challenge.id, "decline")}
                                  disabled={isChallengeLoading}
                                >
                                  {challengeActionLoadingKey === `decline-${challenge.id}`
                                    ? "Declining..."
                                    : "Decline"}
                                </button>
                              ) : null}
                              {challenge.can_cancel ? (
                                <button
                                  type="button"
                                  className="secondary-btn"
                                  onClick={() => handleChallengeAction(challenge.id, "cancel")}
                                  disabled={isChallengeLoading}
                                >
                                  {challengeActionLoadingKey === `cancel-${challenge.id}`
                                    ? "Canceling..."
                                    : "Cancel"}
                                </button>
                              ) : null}
                              {challenge.can_start ? (
                                <button
                                  type="button"
                                  className="secondary-btn"
                                  onClick={() => navigate(`/challenges/${challenge.id}`)}
                                >
                                  Start Challenge
                                </button>
                              ) : null}
                              {challenge.can_view_result ? (
                                <button
                                  type="button"
                                  className="secondary-btn"
                                  onClick={() => navigate(`/challenges/${challenge.id}`)}
                                >
                                  View Result
                                </button>
                              ) : null}
                              {challenge.can_rematch ? (
                                <button
                                  type="button"
                                  className="secondary-btn"
                                  onClick={() => navigate(`/challenges/${challenge.id}`)}
                                >
                                  Rematch
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </article>
                      );
                    }

                    if (!item.message) {
                      return null;
                    }

                    const message = item.message;
                    const isMine = message.sender_id === user?.id;
                    const isVoiceMessage = message.kind === "voice" && message.voice?.url;
                    const isCallEventMessage = message.kind === "call_event";
                    if (isCallEventMessage) {
                      const eventType = message.metadata?.event_type || "";
                      return (
                        <article key={item.id} className={`social-call-event-item is-${eventType}`}>
                          <span className="social-call-event-label">{message.body}</span>
                          <span className="social-call-event-time">
                            {formatDateLabel(message.created_at)}
                          </span>
                        </article>
                      );
                    }
                    return (
                      <article
                        key={item.id}
                        className={`social-message-bubble ${isMine ? "is-mine" : "is-peer"} ${
                          isVoiceMessage ? "is-voice" : ""
                        }`}
                      >
                        {isVoiceMessage ? (
                          <div className="social-voice-message">
                            <VoiceMessagePlayer
                              playerId={`voice-message-${message.id}`}
                              src={toApiAssetUrl(message.voice.url)}
                              durationSeconds={message.voice?.duration_seconds}
                              tone={isMine ? "mine" : "peer"}
                            />
                          </div>
                        ) : (
                          <p>{message.body}</p>
                        )}
                        <footer>
                          <span>{formatDateLabel(message.created_at)}</span>
                          {isMine ? (
                            <span className="social-message-delivery">
                              {message.is_seen ? "Seen" : "Sent"}
                            </span>
                          ) : null}
                        </footer>
                      </article>
                    );
                  })}
                </div>

                <form
                  className={`social-message-form ${
                    isRecordingVoice || recordedVoiceBlob ? "is-voice-active" : ""
                  } ${isUploadingVoice ? "is-uploading-voice" : ""} ${
                    isStoppingVoice ? "is-stopping-voice" : ""
                  }`}
                  onSubmit={handleSendMessage}
                >
                  <div
                    className={`social-message-input-surface ${
                      isRecordingVoice ? "is-recording" : recordedVoiceBlob ? "is-voice-ready" : ""
                    }`}
                  >
                    {isRecordingVoice ? (
                      <div className="social-recording-inline">
                        <div className="social-recording-meta">
                          <span className="social-recording-dot" />
                          <span className="social-recording-label">
                            {isStoppingVoice ? "Finalizing" : "Recording"}
                          </span>
                          <strong>{formatDurationLabel(recordingSeconds)}</strong>
                        </div>
                        <div className="social-recording-meter" aria-hidden="true">
                          {VOICE_WAVEFORM_PATTERN.slice(0, 14).map((height, index) => (
                            <span
                              key={`recording-meter-${index}`}
                              style={{
                                "--recording-meter-height": `${height}%`,
                                "--recording-meter-delay": `${index * 54}ms`
                              }}
                            />
                          ))}
                        </div>
                        <div className="social-recording-actions">
                          <button
                            type="button"
                            className="secondary-btn social-icon-btn"
                            onClick={() => stopVoiceRecording({ discard: true })}
                            disabled={
                              !activeConversation.can_message || isUploadingVoice || isStoppingVoice
                            }
                            aria-label="Cancel recording"
                            title="Cancel recording"
                          >
                            <IconClose />
                          </button>
                          <button
                            type="button"
                            className="primary-btn social-send-icon-btn"
                            onClick={handleSendVoiceMessage}
                            disabled={
                              !activeConversation.can_message || isUploadingVoice || isStoppingVoice
                            }
                            aria-label="Send recording"
                            title="Send recording"
                          >
                            {isUploadingVoice || isStoppingVoice ? "..." : <IconSend />}
                          </button>
                        </div>
                      </div>
                    ) : recordedVoiceBlob ? (
                      <div className="social-voice-draft-inline">
                        <VoiceMessagePlayer
                          playerId="voice-draft"
                          src={recordedVoicePreviewUrl}
                          durationSeconds={recordedVoiceDuration}
                          tone="mine"
                          compact
                        />
                        <div className="social-recording-actions">
                          <button
                            type="button"
                            className="secondary-btn social-icon-btn"
                            onClick={clearVoiceDraft}
                            disabled={isUploadingVoice || isStoppingVoice}
                            aria-label="Discard voice draft"
                            title="Discard draft"
                          >
                            <IconClose />
                          </button>
                          <button
                            type="button"
                            className="primary-btn social-send-icon-btn"
                            onClick={handleSendVoiceMessage}
                            disabled={
                              !activeConversation.can_message || isUploadingVoice || isStoppingVoice
                            }
                            aria-label="Send voice message"
                            title="Send voice message"
                          >
                            {isUploadingVoice || isStoppingVoice ? "..." : <IconSend />}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="social-input-inline-row">
                        <input
                          type="text"
                          value={messageDraft}
                          onChange={handleMessageDraftChange}
                          placeholder={
                            activeConversation.can_message
                              ? "Write a message..."
                              : "Messaging is disabled until you are friends again."
                          }
                          disabled={
                            !activeConversation.can_message ||
                            isSendingMessage ||
                            isUploadingVoice ||
                            isStoppingVoice
                          }
                        />
                        <button
                          type="button"
                          className="secondary-btn social-icon-btn social-input-mic-btn"
                          onClick={handleStartVoiceRecording}
                          disabled={
                            !activeConversation.can_message ||
                            isUploadingVoice ||
                            isSendingMessage ||
                            isStoppingVoice ||
                            !isVoiceRecordingSupported
                          }
                          aria-label="Record voice message"
                          title={
                            isVoiceRecordingSupported
                              ? "Record voice message"
                              : "Voice recording is unavailable in this browser"
                          }
                        >
                          <IconMic />
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="social-message-form-actions">
                    {!isRecordingVoice && !recordedVoiceBlob ? (
                      <button
                        type="submit"
                        className="primary-btn social-send-btn"
                        disabled={
                          !activeConversation.can_message ||
                          isSendingMessage ||
                          isUploadingVoice ||
                          isStoppingVoice ||
                          !messageDraft.trim()
                        }
                      >
                        {isSendingMessage ? "Sending..." : "Send"}
                      </button>
                    ) : null}
                  </div>
                </form>

                {voiceComposerError ? <p className="error-text">{voiceComposerError}</p> : null}
              </>
            ) : (
              <div className="social-chat-empty">
                <span className="social-empty-badge">Social Arena</span>
                <h2>Select a conversation</h2>
                <p className="subtle-text">
                  Choose a thread from the left panel to start messaging and coordinate challenges.
                </p>
              </div>
            )}
          </section>

          <aside className="feature-card social-side-info">
            <div className="social-side-head">
              <h2>Player Preview</h2>
              <span className="social-inline-badge is-default">Live</span>
            </div>

            {activePeer ? (
              <>
                <div className="social-side-profile">
                  <span className="social-avatar-chip social-avatar-chip-lg">
                    {initialsForUser(activePeer)}
                    <span
                      className={`social-presence-dot ${
                        activePeerPresence?.in_call
                          ? "is-call"
                          : activePeerPresence?.is_online
                            ? "is-online"
                            : ""
                      }`}
                    />
                  </span>
                  <div>
                    <p className="social-item-title">{displayNameForUser(activePeer)}</p>
                    <p className="social-item-subtitle">{identityLineForUser(activePeer)}</p>
                    <p
                      className={`social-side-presence ${
                        activeConversationActivity ? "is-active" : ""
                      }`}
                    >
                      {activePeerStatusLabel}
                    </p>
                  </div>
                </div>

                <section className="social-side-highlight-grid">
                  <article>
                    <span>Level</span>
                    <strong>{estimatedLevel}</strong>
                  </article>
                  <article>
                    <span>Thread Streak</span>
                    <strong>{threadStreak}</strong>
                  </article>
                </section>

                <div className="social-side-stats">
                  <article>
                    <span>Messages</span>
                    <strong>{messageSummary.totalMessages}</strong>
                  </article>
                  <article>
                    <span>Challenges</span>
                    <strong>{challengeSummary.challengeCount}</strong>
                  </article>
                  <article>
                    <span>First Message</span>
                    <strong>
                      {messageSummary.firstMessageAt ? formatShortDate(messageSummary.firstMessageAt) : "--"}
                    </strong>
                  </article>
                  <article>
                    <span>Last Activity</span>
                    <strong>
                      {messageSummary.lastMessageAt
                        ? formatDateLabel(messageSummary.lastMessageAt)
                        : "--"}
                    </strong>
                  </article>
                </div>

                <div className="social-side-badges">
                  {profileBadges.map((badge) => (
                    <span key={badge} className="social-inline-badge is-default">
                      {badge}
                    </span>
                  ))}
                </div>

                <div className="social-side-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => handleChatAction("call")}
                    disabled={
                      isCallActionLoading ||
                      activePeerUnavailableForCall ||
                      (!activeConversation?.can_message &&
                        !(isCallLive && activeCall?.conversation_id === activeConversation?.id))
                    }
                  >
                    {isCallLive && activeCall?.conversation_id === activeConversation?.id
                      ? "Return to Call"
                      : activePeerUnavailableForCall
                        ? "In Call"
                      : "Voice Call"}
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => handleChatAction("challenge")}
                  >
                    Challenge Friend
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => handleChatAction("share")}
                  >
                    Share Result
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => handleChatAction("profile")}
                  >
                    View Profile
                  </button>
                </div>
              </>
            ) : (
              <p className="subtle-text">
                Select a conversation to view player identity, thread momentum, and quick social actions.
              </p>
            )}
          </aside>
        </section>
      </section>

      <audio ref={remoteAudioRef} className="social-call-remote-audio" autoPlay playsInline />

      <CallOverlay
        visible={isCallOverlayVisible}
        phase={
          callPhase === "idle" && incomingCall
            ? "incoming"
            : callPhase === "calling" && activeCallStatus === "ringing"
              ? "ringing"
              : callPhase
        }
        call={
          callPhase === "incoming" || callPhase === "accepting"
            ? incomingCall ?? activeCall
            : activeCall ?? incomingCall
        }
        peer={callOverlayPeer}
        durationSeconds={callDurationSeconds}
        callError={callError}
        isMuted={isCallMuted}
        isSpeakerOn={isCallSpeakerOn}
        isActionLoading={isCallActionLoading}
        onAccept={handleAcceptIncomingCall}
        onDecline={handleDeclineIncomingCall}
        onCancel={handleCancelOrEndCall}
        onEnd={handleCancelOrEndCall}
        onToggleMute={toggleCallMute}
        onToggleSpeaker={toggleCallSpeaker}
      />

      {isChallengeComposerOpen ? (
        <div className="social-modal-overlay" role="presentation">
          <section className="social-modal-card" role="dialog" aria-modal="true">
            <header className="social-modal-head">
              <div>
                <p className="brand-mark">English Lemon</p>
                <h2>Create Challenge</h2>
              </div>
              <button
                type="button"
                className="secondary-btn social-mini-btn"
                onClick={() => setIsChallengeComposerOpen(false)}
                disabled={challengeSubmitting}
              >
                Close
              </button>
            </header>

            <form className="social-modal-form" onSubmit={handleChallengeSubmit}>
              <label>
                Challenge Title
                <input
                  type="text"
                  value={challengeForm.title}
                  onChange={(event) =>
                    setChallengeForm((previous) => ({ ...previous, title: event.target.value }))
                  }
                  placeholder="Quick Quiz Challenge"
                  maxLength={140}
                  disabled={challengeSubmitting}
                />
              </label>

              <label>
                Category
                <select
                  value={challengeForm.category}
                  onChange={(event) =>
                    setChallengeForm((previous) => ({ ...previous, category: event.target.value }))
                  }
                  disabled={challengeSubmitting}
                >
                  {CHALLENGE_CATEGORY_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Difficulty
                <select
                  value={challengeForm.difficulty}
                  onChange={(event) =>
                    setChallengeForm((previous) => ({ ...previous, difficulty: event.target.value }))
                  }
                  disabled={challengeSubmitting}
                >
                  {CHALLENGE_DIFFICULTY_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Expiration
                <select
                  value={challengeForm.expiresInMinutes}
                  onChange={(event) =>
                    setChallengeForm((previous) => ({
                      ...previous,
                      expiresInMinutes: Number(event.target.value)
                    }))
                  }
                  disabled={challengeSubmitting}
                >
                  {CHALLENGE_EXPIRY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              {challengeError ? <p className="error-text">{challengeError}</p> : null}

              <div className="social-modal-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => setIsChallengeComposerOpen(false)}
                  disabled={challengeSubmitting}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary-btn"
                  disabled={challengeSubmitting || !challengeForm.title.trim()}
                >
                  {challengeSubmitting ? "Sending..." : "Send Challenge"}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </main>
  );
}

export default SocialPage;
