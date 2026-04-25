const DEFAULT_API_HOST =
  typeof window !== "undefined" && window.location?.hostname
    ? window.location.hostname
    : "127.0.0.1";
const DEFAULT_API_ORIGIN =
  typeof window !== "undefined" && window.location?.origin
    ? window.location.origin
    : "http://127.0.0.1:8000";
const RAW_API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  import.meta.env.VITE_API_BASE_URL ||
  (import.meta.env.DEV ? `http://${DEFAULT_API_HOST}:8000` : DEFAULT_API_ORIGIN);
const NORMALIZED_API_BASE_URL = RAW_API_BASE_URL.replace(/\/+$/, "");
const API_BASE_URL = /\/api(?:\/v\d+)?$/i.test(NORMALIZED_API_BASE_URL)
  ? NORMALIZED_API_BASE_URL
  : `${NORMALIZED_API_BASE_URL}/api`;
const API_ORIGIN = API_BASE_URL.replace(/\/api(?:\/v\d+)?$/i, "");
const WS_API_BASE_URL = API_BASE_URL.replace(/^http/i, "ws");
const API_HEALTH_URL = `${API_ORIGIN}/health`;

const TOKEN_STORAGE_KEY = "english_lemon_token";
const REQUEST_TIMEOUT_MS = 15000;

class ApiError extends Error {
  constructor(message, { status, data, url } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    this.url = url;
    this.detail = typeof data?.detail === "string" ? data.detail : undefined;
  }
}

function extractErrorMessage(data, fallbackMessage) {
  if (typeof data?.detail === "string" && data.detail.trim()) {
    return data.detail;
  }

  if (Array.isArray(data?.detail) && data.detail.length) {
    const firstItem = data.detail[0];
    if (typeof firstItem === "string" && firstItem.trim()) {
      return firstItem;
    }
    if (typeof firstItem?.msg === "string" && firstItem.msg.trim()) {
      return firstItem.msg;
    }
  }

  if (typeof data?.message === "string" && data.message.trim()) {
    return data.message;
  }

  return fallbackMessage;
}

function isAbsoluteUrl(url) {
  return /^https?:\/\//i.test(url);
}

function buildUrl(path) {
  if (isAbsoluteUrl(path)) {
    return path;
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

function toApiAssetUrl(pathOrUrl) {
  if (!pathOrUrl) {
    return "";
  }
  if (isAbsoluteUrl(pathOrUrl)) {
    return pathOrUrl;
  }
  const normalizedPath = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${API_ORIGIN}${normalizedPath}`;
}

function getAuthToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

function buildWebSocketUrl(path, params = {}) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${WS_API_BASE_URL}${normalizedPath}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim()) {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

function normalizeHeaders(initialHeaders, includeJsonContentType) {
  const headers = new Headers(initialHeaders || {});
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }
  if (includeJsonContentType && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}

function isRawBody(body) {
  if (body == null) {
    return false;
  }
  return (
    typeof body === "string" ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer
  );
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildRequestBody(body) {
  if (body == null) {
    return { body: undefined, includeJsonContentType: false };
  }

  if (isRawBody(body)) {
    return { body, includeJsonContentType: false };
  }

  return { body: JSON.stringify(body), includeJsonContentType: true };
}

async function request(method, path, options = {}) {
  const {
    body: rawBody,
    auth = true,
    headers: customHeaders,
    timeout = REQUEST_TIMEOUT_MS,
    ...restOptions
  } = options;

  const { body, includeJsonContentType } = buildRequestBody(rawBody);
  const headers = normalizeHeaders(customHeaders, includeJsonContentType);

  if (auth) {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  const url = buildUrl(path);
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      ...restOptions
    });

    const data = await parseJsonResponse(response);

    if (!response.ok) {
      throw new ApiError(
        extractErrorMessage(data, `Request failed (${response.status}).`),
        {
        status: response.status,
        data,
        url
        }
      );
    }

    return data;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (error?.name === "AbortError") {
      throw new ApiError("Request timed out.", { status: 408, url });
    }

    throw new ApiError(
      `Cannot reach API server at ${API_BASE_URL}. Please check backend connection.`,
      { url }
    );
  } finally {
    clearTimeout(timerId);
  }
}

const api = {
  get(path, options) {
    return request("GET", path, options);
  },
  post(path, body, options) {
    return request("POST", path, { ...options, body });
  },
  put(path, body, options) {
    return request("PUT", path, { ...options, body });
  },
  patch(path, body, options) {
    return request("PATCH", path, { ...options, body });
  },
  delete(path, options) {
    return request("DELETE", path, options);
  }
};

export { ApiError, API_BASE_URL, API_HEALTH_URL, buildWebSocketUrl, getAuthToken, toApiAssetUrl };
export default api;
