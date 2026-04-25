import { Component } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import ProtectedRoute from "./components/ProtectedRoute";
import { useAuth } from "./context/AuthContext";
import DashboardPage from "./pages/DashboardPage";
import LeaderboardPage from "./pages/LeaderboardPage";
import LoginPage from "./pages/LoginPage";
import ProfilePage from "./pages/ProfilePage";
import QuizPage from "./pages/QuizPage";
import RegisterPage from "./pages/RegisterPage";
import SocialPage from "./pages/SocialPage";

function RootRedirect() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="page-shell">
        <div className="loading-text">Loading...</div>
      </div>
    );
  }

  return <Navigate to={user ? "/dashboard" : "/login"} replace />;
}

class SocialPageBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("[SocialPage] render failed", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="page-shell social-page">
          <section className="social-shell">
            <div className="feature-card social-chat-empty">
              <span className="social-empty-badge">Social Arena</span>
              <h2>Social page needs a refresh</h2>
              <p className="subtle-text">
                The app loaded, but the social workspace hit a display issue. Refresh the page or try again in a moment.
              </p>
              <button
                type="button"
                className="primary-btn"
                onClick={() => {
                  this.setState({ error: null });
                  window.location.reload();
                }}
              >
                Refresh Social
              </button>
            </div>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/quiz"
        element={
          <ProtectedRoute>
            <QuizPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/profile"
        element={
          <ProtectedRoute>
            <ProfilePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/leaderboard"
        element={
          <ProtectedRoute>
            <LeaderboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/social"
        element={
          <ProtectedRoute>
            <SocialPageBoundary>
              <SocialPage />
            </SocialPageBoundary>
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
