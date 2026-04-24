import { useState } from "react";
import FeatureCard from "./FeatureCard";
import InfoTile from "./InfoTile";
import PronunciationControls from "./PronunciationControls";
import api from "../../api/client";
import { parseDictionaryEntry } from "../../features/vocabulary/parseDictionaryEntry";

const LOOKUP_STATUS = {
  IDLE: "idle",
  LOADING: "loading",
  EMPTY: "empty",
  ERROR: "error",
  SUCCESS: "success"
};

function VocabularyStatus({ status, message }) {
  if (status === LOOKUP_STATUS.SUCCESS) {
    return null;
  }

  const statusClassName = {
    [LOOKUP_STATUS.IDLE]: "status-note-idle",
    [LOOKUP_STATUS.LOADING]: "status-note-loading",
    [LOOKUP_STATUS.EMPTY]: "status-note-empty",
    [LOOKUP_STATUS.ERROR]: "status-note-error"
  }[status];

  return <p className={`status-note ${statusClassName}`}>{message}</p>;
}

function VocabularyCard() {
  const [word, setWord] = useState("");
  const [status, setStatus] = useState(LOOKUP_STATUS.IDLE);
  const [message, setMessage] = useState("Search a word to see meanings and usage.");
  const [result, setResult] = useState(null);

  const handleSearch = async (event) => {
    event.preventDefault();
    const cleanedWord = word.trim();

    if (!cleanedWord) {
      setStatus(LOOKUP_STATUS.ERROR);
      setMessage("Please enter an English word.");
      setResult(null);
      return;
    }

    setStatus(LOOKUP_STATUS.LOADING);
    setMessage(`Finding "${cleanedWord}"...`);
    setResult(null);

    try {
      const response = await api.get(
        `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(cleanedWord)}`,
        { auth: false }
      );

      const entry = response?.[0];
      if (!entry) {
        setStatus(LOOKUP_STATUS.EMPTY);
        setMessage(`No result found for "${cleanedWord}".`);
        return;
      }

      const parsedResult = parseDictionaryEntry(entry);
      if (!parsedResult.hasUsefulData) {
        setStatus(LOOKUP_STATUS.EMPTY);
        setMessage(`No useful definition data found for "${cleanedWord}".`);
        return;
      }

      setResult(parsedResult);
      setStatus(LOOKUP_STATUS.SUCCESS);
      setMessage("");
    } catch (error) {
      const notFound = error?.status === 404;
      if (notFound) {
        setStatus(LOOKUP_STATUS.EMPTY);
        setMessage(`No result found for "${cleanedWord}".`);
      } else {
        setStatus(LOOKUP_STATUS.ERROR);
        setMessage("Could not fetch the dictionary right now. Please try again.");
      }
    }
  };

  return (
    <FeatureCard
      title="Vocabulary"
      description="Look up a word and capture meaning, usage, and pronunciation."
      badgeLabel="Live"
      badgeTone="live"
      className="vocabulary-card"
    >
      <form onSubmit={handleSearch} className="vocab-form">
        <label className="sr-only" htmlFor="vocab-search">
          Search word
        </label>
        <input
          id="vocab-search"
          className="vocab-input"
          type="text"
          value={word}
          onChange={(event) => setWord(event.target.value)}
          placeholder="Type a word, for example resilient"
          autoComplete="off"
        />
        <button
          type="submit"
          className="primary-btn vocab-submit-btn"
          disabled={status === LOOKUP_STATUS.LOADING}
        >
          {status === LOOKUP_STATUS.LOADING ? "Searching..." : "Search"}
        </button>
      </form>

      <VocabularyStatus status={status} message={message} />

      {status === LOOKUP_STATUS.SUCCESS && result ? (
        <div className="vocab-results">
          <InfoTile label="Meaning">
            <p>{result.meaning}</p>
          </InfoTile>

          <InfoTile label="Example">
            <p>{result.example}</p>
          </InfoTile>

          <InfoTile label="Synonyms">
            {result.synonyms.length ? (
              <div className="synonym-list">
                {result.synonyms.map((synonym) => (
                  <span key={synonym} className="synonym-pill">
                    {synonym}
                  </span>
                ))}
              </div>
            ) : (
              <p className="inline-muted-text">No synonyms available.</p>
            )}
          </InfoTile>

          <InfoTile label="Pronunciation">
            <PronunciationControls pronunciation={result.pronunciation} />
          </InfoTile>
        </div>
      ) : null}
    </FeatureCard>
  );
}

export default VocabularyCard;
