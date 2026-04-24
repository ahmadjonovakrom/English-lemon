let sharedAudioContext = null;

function getAudioContext() {
  if (typeof window === "undefined") {
    return null;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return null;
  }

  if (!sharedAudioContext) {
    sharedAudioContext = new AudioContextClass();
  }

  return sharedAudioContext;
}

function scheduleTone(ctx, note) {
  const oscillator = ctx.createOscillator();
  const gainNode = ctx.createGain();

  oscillator.type = note.type ?? "sine";
  oscillator.frequency.setValueAtTime(note.frequency, note.startTime);

  gainNode.gain.setValueAtTime(0.0001, note.startTime);
  gainNode.gain.linearRampToValueAtTime(note.volume, note.startTime + 0.012);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, note.startTime + note.duration);

  oscillator.connect(gainNode);
  gainNode.connect(ctx.destination);

  oscillator.start(note.startTime);
  oscillator.stop(note.startTime + note.duration + 0.02);
}

async function playPattern(pattern) {
  const ctx = getAudioContext();
  if (!ctx) {
    return;
  }

  if (ctx.state !== "running") {
    try {
      await ctx.resume();
    } catch {
      return;
    }
  }

  const now = ctx.currentTime + 0.01;
  pattern.forEach((step, index) => {
    const offset = pattern.slice(0, index).reduce((sum, item) => sum + item.delay, 0);
    scheduleTone(ctx, {
      startTime: now + offset,
      frequency: step.frequency,
      duration: step.duration,
      volume: step.volume,
      type: step.type
    });
  });
}

export async function primeQuizAudio() {
  const ctx = getAudioContext();
  if (!ctx || ctx.state === "running") {
    return;
  }

  try {
    await ctx.resume();
  } catch {
    // Autoplay restrictions are handled by failing silently.
  }
}

export function playCorrectAnswerSound() {
  void playPattern([
    { frequency: 620, duration: 0.09, volume: 0.032, delay: 0, type: "triangle" },
    { frequency: 820, duration: 0.12, volume: 0.028, delay: 0.06, type: "triangle" }
  ]);
}

export function playWrongAnswerSound() {
  void playPattern([
    { frequency: 300, duration: 0.12, volume: 0.028, delay: 0, type: "sawtooth" },
    { frequency: 215, duration: 0.15, volume: 0.022, delay: 0.07, type: "sine" }
  ]);
}

export function playRewardSound() {
  void playPattern([
    { frequency: 523, duration: 0.12, volume: 0.028, delay: 0, type: "triangle" },
    { frequency: 659, duration: 0.12, volume: 0.03, delay: 0.06, type: "triangle" },
    { frequency: 784, duration: 0.18, volume: 0.034, delay: 0.07, type: "sine" }
  ]);
}
