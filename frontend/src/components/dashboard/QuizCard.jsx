import { useNavigate } from "react-router-dom";
import FeatureCard from "./FeatureCard";

function QuizCard() {
  const navigate = useNavigate();

  return (
    <FeatureCard
      title="Quiz Game"
      description="Fast rounds, instant feedback, and lemon rewards."
      badgeLabel="New"
      badgeTone="live"
      className="quiz-entry-card"
    >
      <ul className="quiz-entry-highlights">
        <li>Category-based rounds: Mixed, Grammar, Vocabulary, and more</li>
        <li>Auto-advance with immediate right/wrong feedback</li>
        <li>Earn lemons and build streak momentum</li>
      </ul>
      <button
        type="button"
        className="primary-btn quiz-entry-btn"
        onClick={() => navigate("/quiz")}
      >
        Start Quiz
      </button>
    </FeatureCard>
  );
}

export default QuizCard;
