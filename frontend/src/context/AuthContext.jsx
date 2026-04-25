import { createContext, useContext, useEffect, useMemo, useState } from "react";
import api from "../api/client";

const AuthContext = createContext(null);
const TOKEN_STORAGE_KEY = "english_lemon_token";

function formatApiError(error, fallbackMessage) {
  if (typeof error?.detail === "string") {
    return error.detail;
  }
  if (typeof error?.data?.detail === "string") {
    return error.data.detail;
  }
  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message;
  }
  return fallbackMessage;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = async () => {
    const profile = await api.get("/users/me");
    setUser(profile);
    return profile;
  };

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (!token) {
      setLoading(false);
      return;
    }

    api
      .get("/users/me")
      .then((response) => {
        setUser(response);
      })
      .catch(() => {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        setUser(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const register = async (payload) => {
    try {
      const response = await api.post("/auth/register", payload);
      localStorage.setItem(TOKEN_STORAGE_KEY, response.access_token);
      await refreshUser();
    } catch (error) {
      throw new Error(formatApiError(error, "Unable to register right now."));
    }
  };

  const login = async (payload) => {
    try {
      const response = await api.post("/auth/login", payload);
      localStorage.setItem(TOKEN_STORAGE_KEY, response.access_token);
      await refreshUser();
    } catch (error) {
      throw new Error(formatApiError(error, "Unable to login right now."));
    }
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    setUser(null);
  };

  const value = useMemo(
    () => ({
      user,
      loading,
      register,
      login,
      logout,
      refreshUser
    }),
    [user, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
