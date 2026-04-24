import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import QuizLaunchPanel from "../components/quiz/QuizLaunchPanel";
import QuizQuestionPanel from "../components/quiz/QuizQuestionPanel";
import QuizResultsPanel from "../components/quiz/QuizResultsPanel";
import QuizStartPanel from "../components/quiz/QuizStartPanel";
import {
  DEFAULT_QUIZ_CATEGORY,
  QUESTIONS_PER_ROUND,
  QUIZ_AUTO_ADVANCE_MS,
  QUIZ_CATEGORY_OPTIONS,
  QUIZ_LAUNCH_TRANSITION_MS,
  QUIZ_RESULTS_TRANSITION_MS
} from "../features/quiz/constants";
import {
  playCorrectAnswerSound,
  playRewardSound,
  playWrongAnswerSound,
  primeQuizAudio
} from "../features/quiz/utils/quizAudio";
import { recordQuizRoundProgress } from "../features/quiz/utils/quizProfileStats";
import { quizQuestions } from "../features/quiz/data/quizQuestions";
import { calculateLemons, calculateQuizResults } from "../features/quiz/utils/quizScoring";

const FALLBACK_QUESTIONS = [
  {
    id: "fallback-q1",
    question: "Choose the correct sentence:",
    options: [
      "She don't likes coffee.",
      "She doesn't like coffee.",
      "She not likes coffee.",
      "She doesn't likes coffee."
    ],
    correctAnswer: 1,
    category: "Grammar",
    difficulty: "Mixed",
    explanation: "With 'she', use 'doesn't' + base verb."
  }
];

function shuffleArray(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function isValidQuestion(question) {
  return Boolean(
    question &&
      typeof question.question === "string" &&
      Array.isArray(question.options) &&
      question.options.length === 4 &&
      Number.isInteger(question.correctAnswer) &&
      question.correctAnswer >= 0 &&
      question.correctAnswer < 4
  );
}

function normalizeQuestionBank(source) {
  if (!Array.isArray(source)) {
    return [];
  }

  return source
    .filter(isValidQuestion)
    .map((question, index) => ({
      ...question,
      id: question.id ?? `quiz-question-${index + 1}`,
      category:
        typeof question.category === "string" && question.category.trim()
          ? question.category
          : DEFAULT_QUIZ_CATEGORY,
      difficulty:
        typeof question.difficulty === "string" && question.difficulty.trim()
          ? question.difficulty
          : "Mixed",
      options: question.options.map((option) => String(option))
    }));
}

function getQuestionPool(category, bank) {
  const safeBank = Array.isArray(bank) ? bank : [];
  if (category === DEFAULT_QUIZ_CATEGORY) {
    return safeBank;
  }
  return safeBank.filter((question) => question.category === category);
}

function buildQuizSet(category, bank) {
  const pool = getQuestionPool(category, bank);
  const roundSize = Math.min(QUESTIONS_PER_ROUND, pool.length);
  return shuffleArray(pool).slice(0, roundSize);
}

function createFeedbackMessage(isCorrect, streak) {
  if (isCorrect && streak >= 3) {
    return `Nice! ${streak}x streak.`;
  }
  if (isCorrect && streak === 2) {
    return "Nice!";
  }
  if (isCorrect) {
    return "Correct!";
  }
  return "Not quite!";
}

function QuizGuardPanel({ status = "loading", question }) {
  const safeQuestion = isValidQuestion(question) ? question : FALLBACK_QUESTIONS[0];
  const heading = status === "error" ? "Failed to load quiz" : "Loading quiz...";

  return (
    <section className="quiz-panel quiz-start-panel">
      <div className="brand-mark">English Lemon</div>
      <h1>Quiz Arena</h1>
      <p className="quiz-panel-subtitle">{heading}</p>

      <div className="quiz-fallback-preview">
        <p className="quiz-counter">Preview</p>
        <h2 className="quiz-question-text">{safeQuestion.question}</h2>
        <div className="quiz-options-grid">
          {safeQuestion.options.map((option, index) => (
            <button
              key={`${safeQuestion.id}-${option}`}
              type="button"
              className="quiz-option-btn"
              disabled
            >
              <div className="quiz-option-head">
                <span className="quiz-option-index">{["A", "B", "C", "D"][index]}</span>
              </div>
              <span className="quiz-option-label">{option}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function QuizResultsTransitionPanel() {
  return (
    <section className="quiz-panel quiz-results-transition-panel" aria-live="polite">
      <div className="brand-mark">English Lemon</div>
      <h1>Round Complete</h1>
      <p className="quiz-panel-subtitle">Preparing your lemon rewards...</p>
      <div className="quiz-results-transition-loader" aria-hidden="true" />
    </section>
  );
}

function QuizPage() {
  const navigate = useNavigate();
  const launchTimeoutRef = useRef(null);
  const autoAdvanceRef = useRef(null);
  const resultsTransitionTimeoutRef = useRef(null);
  const roundIdRef = useRef("");
  const persistedRoundIdRef = useRef("");
  const interactionLockedRef = useRef(false);
  const [questionBank, setQuestionBank] = useState(null);
  const [questionBankError, setQuestionBankError] = useState("");
  const [phase, setPhase] = useState("start");
  const [selectedCategory, setSelectedCategory] = useState(DEFAULT_QUIZ_CATEGORY);
  const [activeCategory, setActiveCategory] = useState(DEFAULT_QUIZ_CATEGORY);
  const [questions, setQuestions] = useState([]);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(null);
  const [isLocked, setIsLocked] = useState(false);
  const [feedbackState, setFeedbackState] = useState("correct");
  const [feedbackMessage, setFeedbackMessage] = useState("Correct!");
  const [answers, setAnswers] = useState([]);
  const [currentStreak, setCurrentStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [sessionLemons, setSessionLemons] = useState(0);
  const currentQuestion = questions[questionIndex];
  const totalQuestions = questions.length;
  const fallbackQuestion = questionBank?.[0] ?? FALLBACK_QUESTIONS[0];

  const clearTimers = () => {
    if (launchTimeoutRef.current) {
      clearTimeout(launchTimeoutRef.current);
      launchTimeoutRef.current = null;
    }
    if (autoAdvanceRef.current) {
      clearTimeout(autoAdvanceRef.current);
      autoAdvanceRef.current = null;
    }
    if (resultsTransitionTimeoutRef.current) {
      clearTimeout(resultsTransitionTimeoutRef.current);
      resultsTransitionTimeoutRef.current = null;
    }
    interactionLockedRef.current = false;
  };

  useEffect(() => {
    try {
      const normalized = normalizeQuestionBank(quizQuestions);
      if (!normalized.length) {
        setQuestionBank(FALLBACK_QUESTIONS);
        setQuestionBankError("Failed to load quiz");
        return;
      }
      setQuestionBank(normalized);
      setQuestionBankError("");
    } catch {
      setQuestionBank(FALLBACK_QUESTIONS);
      setQuestionBankError("Failed to load quiz");
    }
  }, []);

  useEffect(
    () => () => {
      clearTimers();
    },
    []
  );

  const availableCount = useMemo(
    () => getQuestionPool(selectedCategory, questionBank).length,
    [selectedCategory, questionBank]
  );
  const startRoundQuestionCount = Math.min(QUESTIONS_PER_ROUND, availableCount);

  const startQuiz = (category) => {
    const roundQuestions = buildQuizSet(category, questionBank);
    const safeRoundQuestions = roundQuestions.length ? roundQuestions : FALLBACK_QUESTIONS;

    clearTimers();
    setQuestions(safeRoundQuestions);
    setActiveCategory(category);
    setQuestionIndex(0);
    setSelectedIndex(null);
    setIsLocked(false);
    setFeedbackState("correct");
    setFeedbackMessage("Correct!");
    setAnswers([]);
    setCurrentStreak(0);
    setBestStreak(0);
    setSessionLemons(0);
    roundIdRef.current = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    persistedRoundIdRef.current = "";
    interactionLockedRef.current = false;
    void primeQuizAudio();
    setPhase("launch");

    launchTimeoutRef.current = setTimeout(() => {
      setPhase("playing");
    }, QUIZ_LAUNCH_TRANSITION_MS);
  };

  const goToResults = () => {
    setPhase("results-transition");
    setSelectedIndex(null);
    setIsLocked(false);
    interactionLockedRef.current = true;

    if (resultsTransitionTimeoutRef.current) {
      clearTimeout(resultsTransitionTimeoutRef.current);
    }

    resultsTransitionTimeoutRef.current = setTimeout(() => {
      resultsTransitionTimeoutRef.current = null;
      setPhase("results");
      interactionLockedRef.current = false;
    }, QUIZ_RESULTS_TRANSITION_MS);
  };

  const handleSelectOption = (optionIndex) => {
    if (interactionLockedRef.current || isLocked || phase !== "playing" || !currentQuestion) {
      return;
    }
    interactionLockedRef.current = true;

    const safeCorrectAnswer =
      Number.isInteger(currentQuestion.correctAnswer) &&
      currentQuestion.correctAnswer >= 0 &&
      currentQuestion.correctAnswer < 4
        ? currentQuestion.correctAnswer
        : 0;

    const isCorrect = optionIndex === safeCorrectAnswer;
    const answerRecord = {
      questionId: currentQuestion.id,
      selectedIndex: optionIndex,
      isCorrect
    };
    const nextStreak = isCorrect ? currentStreak + 1 : 0;
    const previousCorrect = answers.filter((entry) => entry.isCorrect).length;
    const nextCorrect = previousCorrect + (isCorrect ? 1 : 0);

    setSelectedIndex(optionIndex);
    setIsLocked(true);
    setFeedbackState(isCorrect ? "correct" : "incorrect");
    setFeedbackMessage(createFeedbackMessage(isCorrect, nextStreak));
    setAnswers((previous) => [...previous, answerRecord]);
    setCurrentStreak(nextStreak);
    setBestStreak((previous) => Math.max(previous, nextStreak));
    setSessionLemons(calculateLemons(nextCorrect));
    void primeQuizAudio();
    if (isCorrect) {
      playCorrectAnswerSound();
    } else {
      playWrongAnswerSound();
    }

    if (autoAdvanceRef.current) {
      clearTimeout(autoAdvanceRef.current);
      autoAdvanceRef.current = null;
    }

    autoAdvanceRef.current = setTimeout(() => {
      autoAdvanceRef.current = null;
      const isFinalQuestion = questionIndex >= totalQuestions - 1;

      if (isFinalQuestion) {
        goToResults();
        return;
      }

      setQuestionIndex((previous) => previous + 1);
      setSelectedIndex(null);
      setIsLocked(false);
      setFeedbackState("correct");
      setFeedbackMessage("Correct!");
      interactionLockedRef.current = false;
    }, QUIZ_AUTO_ADVANCE_MS);
  };

  useEffect(() => {
    if (phase === "results") {
      playRewardSound();
    }
  }, [phase]);

  const handlePlayAgain = () => {
    startQuiz(activeCategory);
  };

  const results = useMemo(
    () => calculateQuizResults(answers, totalQuestions, bestStreak),
    [answers, totalQuestions, bestStreak]
  );

  useEffect(() => {
    if (phase !== "results") {
      return;
    }

    const currentRoundId = roundIdRef.current;
    if (!currentRoundId || persistedRoundIdRef.current === currentRoundId) {
      return;
    }

    recordQuizRoundProgress({
      category: activeCategory,
      lemonsEarned: results.lemonsEarned,
      totalCorrect: results.totalCorrect,
      totalQuestions,
      currentStreak,
      bestStreak: results.bestStreak
    });

    persistedRoundIdRef.current = currentRoundId;
  }, [activeCategory, currentStreak, phase, results, totalQuestions]);

  const progressPercent = totalQuestions
    ? Math.round(((questionIndex + 1) / totalQuestions) * 100)
    : 0;

  if (questionBank === null) {
    return (
      <main className="page-shell quiz-page">
        <section className="quiz-shell">
          <QuizGuardPanel status="loading" question={FALLBACK_QUESTIONS[0]} />
        </section>
      </main>
    );
  }

  if (!questionBank.length) {
    return (
      <main className="page-shell quiz-page">
        <section className="quiz-shell">
          <QuizGuardPanel status="error" question={FALLBACK_QUESTIONS[0]} />
        </section>
      </main>
    );
  }

  return (
    <main className="page-shell quiz-page">
      <section className="quiz-shell">
        {phase === "start" ? (
          <QuizStartPanel
            categories={QUIZ_CATEGORY_OPTIONS}
            selectedCategory={selectedCategory}
            onSelectCategory={setSelectedCategory}
            availableCount={availableCount}
            totalQuestions={startRoundQuestionCount}
            onStart={() => startQuiz(selectedCategory)}
            errorMessage={questionBankError}
          />
        ) : null}

        {phase === "launch" ? (
          <QuizLaunchPanel category={activeCategory} totalQuestions={totalQuestions} />
        ) : null}

        {phase === "playing" && currentQuestion ? (
          <QuizQuestionPanel
            question={currentQuestion}
            questionNumber={questionIndex + 1}
            totalQuestions={totalQuestions}
            selectedIndex={selectedIndex}
            isLocked={isLocked}
            onSelectOption={handleSelectOption}
            feedbackState={feedbackState}
            feedbackMessage={feedbackMessage}
            progressPercent={progressPercent}
            sessionLemons={sessionLemons}
            currentStreak={currentStreak}
          />
        ) : null}

        {phase === "playing" && !currentQuestion ? (
          <QuizGuardPanel status="error" question={fallbackQuestion} />
        ) : null}

        {phase === "results-transition" ? <QuizResultsTransitionPanel /> : null}

        {phase === "results" ? (
          <QuizResultsPanel
            results={results}
            totalQuestions={totalQuestions}
            category={activeCategory}
            onPlayAgain={handlePlayAgain}
            onBackToDashboard={() => navigate("/dashboard")}
          />
        ) : null}
      </section>
    </main>
  );
}

export default QuizPage;
