import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import ComingSoonCard from "../components/dashboard/ComingSoonCard";
import DashboardHeader from "../components/dashboard/DashboardHeader";
import QuizCard from "../components/dashboard/QuizCard";
import VocabularyCard from "../components/dashboard/VocabularyCard";
import { useAuth } from "../context/AuthContext";

function DashboardPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const displayName = useMemo(() => {
    if (!user?.username) return "Learner";
    return user.username;
  }, [user]);

  const handleLogout = () => {
    logout();
    navigate("/login", { replace: true });
  };

  return (
    <main className="page-shell dashboard-page">
      <section className="dashboard-shell">
        <DashboardHeader
          username={displayName}
          onOpenLeaderboard={() => navigate("/leaderboard")}
          onOpenSocial={() => navigate("/social")}
          onOpenProfile={() => navigate("/profile")}
          onLogout={handleLogout}
        />

        <section className="dashboard-layout">
          <div className="dashboard-main-column">
            <VocabularyCard />
          </div>

          <aside className="dashboard-side-column">
            <QuizCard />
            <ComingSoonCard
              title="Reading"
              description="Structured reading sessions with level progression."
              milestones={[
                "Level-based passages",
                "Vocabulary highlights",
                "Reading streak insights"
              ]}
            />
            <ComingSoonCard
              title="Shadowing"
              description="Speech practice powered by timing and fluency feedback."
              milestones={[
                "Sentence-level practice",
                "Pacing and pause scoring",
                "Pronunciation tracking"
              ]}
            />
          </aside>
        </section>
      </section>
    </main>
  );
}

export default DashboardPage;
