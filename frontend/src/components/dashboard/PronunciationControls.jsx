import { useEffect, useRef, useState } from "react";

const PLAYBACK_STATUS = {
  IDLE: "idle",
  LOADING: "loading",
  PLAYING: "playing",
  ERROR: "error"
};

function getAccentLabel(accent) {
  return accent === "uk" ? "UK" : "US";
}

function createInitialPlaybackState() {
  return {
    status: PLAYBACK_STATUS.IDLE,
    accent: null,
    mode: "single",
    errorMessage: ""
  };
}

function PronunciationControls({ pronunciation }) {
  const audioRef = useRef(null);
  const queueRef = useRef([]);
  const playNextRef = useRef(null);
  const [playbackState, setPlaybackState] = useState(createInitialPlaybackState);

  const usPhonetic = pronunciation?.us?.phonetic || "";
  const ukPhonetic = pronunciation?.uk?.phonetic || "";
  const usAudioUrl = pronunciation?.us?.audioUrl || "";
  const ukAudioUrl = pronunciation?.uk?.audioUrl || "";
  const hasUsAudio = Boolean(usAudioUrl);
  const hasUkAudio = Boolean(ukAudioUrl);
  const hasAnyAudio = hasUsAudio || hasUkAudio;
  const canPlayBoth = hasUsAudio && hasUkAudio;

  function stopPlayback() {
    queueRef.current = [];
    const activeAudio = audioRef.current;
    if (!activeAudio) {
      return;
    }

    activeAudio.onended = null;
    activeAudio.onerror = null;
    activeAudio.pause();
    activeAudio.src = "";
    audioRef.current = null;
  }

  async function playNext(mode) {
    const nextTrack = queueRef.current.shift();
    if (!nextTrack) {
      setPlaybackState(createInitialPlaybackState());
      return;
    }

    const { accent, audioUrl } = nextTrack;
    stopPlayback();
    setPlaybackState({
      status: PLAYBACK_STATUS.LOADING,
      accent,
      mode,
      errorMessage: ""
    });

    const audio = new Audio(audioUrl);
    audio.preload = "auto";
    audioRef.current = audio;

    audio.onended = () => {
      if (queueRef.current.length > 0) {
        playNextRef.current?.(mode);
      } else {
        stopPlayback();
        setPlaybackState(createInitialPlaybackState());
      }
    };

    audio.onerror = () => {
      stopPlayback();
      setPlaybackState({
        status: PLAYBACK_STATUS.ERROR,
        accent,
        mode,
        errorMessage: `Unable to play ${getAccentLabel(accent)} audio.`
      });
    };

    try {
      await audio.play();
      setPlaybackState({
        status: PLAYBACK_STATUS.PLAYING,
        accent,
        mode,
        errorMessage: ""
      });
    } catch {
      stopPlayback();
      setPlaybackState({
        status: PLAYBACK_STATUS.ERROR,
        accent,
        mode,
        errorMessage: "Playback is unavailable right now. Please try again."
      });
    }
  }

  playNextRef.current = playNext;

  useEffect(() => {
    return () => {
      stopPlayback();
    };
  }, []);

  useEffect(() => {
    setPlaybackState(createInitialPlaybackState());
    stopPlayback();
  }, [usAudioUrl, ukAudioUrl, usPhonetic, ukPhonetic]);

  const isLoading = playbackState.status === PLAYBACK_STATUS.LOADING;
  const isPlayingUs =
    playbackState.status === PLAYBACK_STATUS.PLAYING && playbackState.accent === "us";
  const isPlayingUk =
    playbackState.status === PLAYBACK_STATUS.PLAYING && playbackState.accent === "uk";
  const isPlayingBoth =
    playbackState.status === PLAYBACK_STATUS.PLAYING && playbackState.mode === "both";

  const handlePlayAccent = (accent) => {
    const audioUrl = accent === "us" ? usAudioUrl : ukAudioUrl;
    if (!audioUrl) {
      return;
    }
    queueRef.current = [{ accent, audioUrl }];
    playNext("single");
  };

  const handlePlayBoth = () => {
    if (!canPlayBoth) {
      return;
    }
    queueRef.current = [
      { accent: "us", audioUrl: usAudioUrl },
      { accent: "uk", audioUrl: ukAudioUrl }
    ];
    playNext("both");
  };

  function getStatusText() {
    if (!hasAnyAudio) {
      return "Audio unavailable for this word.";
    }
    if (playbackState.status === PLAYBACK_STATUS.LOADING) {
      return `Loading ${getAccentLabel(playbackState.accent || "us")} audio...`;
    }
    if (playbackState.status === PLAYBACK_STATUS.PLAYING) {
      if (playbackState.mode === "both") {
        return `Playing ${getAccentLabel(playbackState.accent || "us")} in sequence...`;
      }
      return `Playing ${getAccentLabel(playbackState.accent || "us")} pronunciation...`;
    }
    if (playbackState.status === PLAYBACK_STATUS.ERROR) {
      return playbackState.errorMessage || "Audio unavailable right now.";
    }
    if (canPlayBoth) {
      return "Choose US, UK, or play both accents.";
    }
    return "Play available accent audio.";
  }

  return (
    <div className="pronunciation-block">
      <div className="phonetic-grid">
        <div className="phonetic-row">
          <span className="phonetic-accent-chip">US</span>
          <p className={`pronunciation-text ${!usPhonetic ? "phonetic-unavailable" : ""}`}>
            {usPhonetic || "Unavailable"}
          </p>
        </div>
        <div className="phonetic-row">
          <span className="phonetic-accent-chip">UK</span>
          <p className={`pronunciation-text ${!ukPhonetic ? "phonetic-unavailable" : ""}`}>
            {ukPhonetic || "Unavailable"}
          </p>
        </div>
      </div>

      <div className="audio-control-row">
        <button
          type="button"
          className={`audio-control-btn ${isPlayingUs ? "is-playing" : ""}`}
          onClick={() => handlePlayAccent("us")}
          disabled={!hasUsAudio || isLoading}
        >
          {!hasUsAudio ? "US Unavailable" : isPlayingUs ? "Playing US" : "Play US"}
        </button>

        <button
          type="button"
          className={`audio-control-btn ${isPlayingUk ? "is-playing" : ""}`}
          onClick={() => handlePlayAccent("uk")}
          disabled={!hasUkAudio || isLoading}
        >
          {!hasUkAudio ? "UK Unavailable" : isPlayingUk ? "Playing UK" : "Play UK"}
        </button>

        {canPlayBoth ? (
          <button
            type="button"
            className={`audio-control-btn is-accent ${isPlayingBoth ? "is-playing" : ""}`}
            onClick={handlePlayBoth}
            disabled={isLoading}
          >
            {isPlayingBoth ? "Playing Both" : "Play Both"}
          </button>
        ) : null}
      </div>

      <p
        className={`audio-status audio-status-${playbackState.status} ${
          !hasAnyAudio ? "audio-status-unavailable" : ""
        }`}
      >
        {getStatusText()}
      </p>
    </div>
  );
}

export default PronunciationControls;
