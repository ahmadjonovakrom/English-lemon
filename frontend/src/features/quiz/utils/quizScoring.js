function getSummaryMessage(accuracy) {
  if (accuracy >= 90) {
    return "Excellent work. Your accuracy is elite this round.";
  }
  if (accuracy >= 75) {
    return "Great job. You're building real momentum.";
  }
  if (accuracy >= 55) {
    return "Nice effort. Another round will lock this in.";
  }
  return "Keep practicing. You're closer than you think.";
}

const LEMONS_PER_CORRECT = 5;

export function calculateLemons(correctCount) {
  return correctCount * LEMONS_PER_CORRECT;
}

export function calculateQuizResults(answerHistory, totalQuestions, bestStreak = 0) {
  const totalCorrect = answerHistory.filter((entry) => entry.isCorrect).length;
  const totalWrong = Math.max(totalQuestions - totalCorrect, 0);
  const accuracy = totalQuestions
    ? Math.round((totalCorrect / totalQuestions) * 100)
    : 0;
  const lemonsEarned = calculateLemons(totalCorrect);
  const summaryMessage = getSummaryMessage(accuracy);

  return {
    totalCorrect,
    totalWrong,
    accuracy,
    lemonsEarned,
    bestStreak,
    summaryMessage
  };
}
