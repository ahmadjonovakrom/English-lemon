const US_PATTERN = /(?:en[-_ ]?us|american|(?:^|[-_/])us(?:[-_/.]|$))/i;
const UK_PATTERN = /(?:en[-_ ]?(?:gb|uk)|british|(?:^|[-_/])uk(?:[-_/.]|$)|(?:^|[-_/])gb(?:[-_/.]|$))/i;

function normalizeAudioUrl(audioUrl = "") {
  const trimmed = audioUrl.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }
  return trimmed;
}

function detectAccent(phoneticNode, normalizedAudioUrl) {
  const sourceUrl = (phoneticNode?.sourceUrl || "").trim();
  const hint = `${normalizedAudioUrl} ${sourceUrl}`.toLowerCase();

  if (US_PATTERN.test(hint)) {
    return "us";
  }
  if (UK_PATTERN.test(hint)) {
    return "uk";
  }
  return "generic";
}

function extractPronunciation(phonetics = [], fallbackPhonetic = "") {
  const pronunciation = {
    us: { phonetic: "", audioUrl: "" },
    uk: { phonetic: "", audioUrl: "" },
    generic: { phonetic: "", audioUrl: "" }
  };

  for (const phoneticNode of phonetics) {
    const text = (phoneticNode?.text || "").trim();
    const audioUrl = normalizeAudioUrl(phoneticNode?.audio || "");
    const accent = detectAccent(phoneticNode, audioUrl);

    if (text && !pronunciation[accent].phonetic) {
      pronunciation[accent].phonetic = text;
    }

    if (audioUrl && !pronunciation[accent].audioUrl) {
      pronunciation[accent].audioUrl = audioUrl;
    }
  }

  if (!pronunciation.us.audioUrl && !pronunciation.uk.audioUrl && pronunciation.generic.audioUrl) {
    pronunciation.us.audioUrl = pronunciation.generic.audioUrl;
  }

  const defaultPhonetic = fallbackPhonetic.trim() || pronunciation.generic.phonetic;

  if (!pronunciation.us.phonetic) {
    pronunciation.us.phonetic = defaultPhonetic;
  }

  if (!pronunciation.uk.phonetic) {
    pronunciation.uk.phonetic = defaultPhonetic;
  }

  const hasAnyAudio = Boolean(pronunciation.us.audioUrl || pronunciation.uk.audioUrl);
  const hasBothAudio = Boolean(pronunciation.us.audioUrl && pronunciation.uk.audioUrl);
  const hasAnyPhonetic = Boolean(pronunciation.us.phonetic || pronunciation.uk.phonetic);

  return {
    us: pronunciation.us,
    uk: pronunciation.uk,
    hasAnyAudio,
    hasBothAudio,
    hasAnyPhonetic
  };
}

export function parseDictionaryEntry(entry) {
  const phonetics = Array.isArray(entry?.phonetics) ? entry.phonetics : [];
  const pronunciation = extractPronunciation(phonetics, entry?.phonetic || "");
  const pronunciationText = pronunciation.us.phonetic || pronunciation.uk.phonetic || "";
  const audioUrl = pronunciation.us.audioUrl || pronunciation.uk.audioUrl || "";

  let meaning = "";
  let example = "";
  const synonymsSet = new Set();

  for (const meaningNode of entry?.meanings || []) {
    for (const synonym of meaningNode?.synonyms || []) {
      if (synonym) {
        synonymsSet.add(synonym);
      }
    }

    for (const definitionNode of meaningNode?.definitions || []) {
      if (!meaning && definitionNode?.definition) {
        meaning = definitionNode.definition.trim();
      }
      if (!example && definitionNode?.example) {
        example = definitionNode.example.trim();
      }

      for (const synonym of definitionNode?.synonyms || []) {
        if (synonym) {
          synonymsSet.add(synonym);
        }
      }
    }
  }

  const synonyms = Array.from(synonymsSet).slice(0, 12);
  const hasUsefulData = Boolean(
    meaning ||
      example ||
      pronunciationText ||
      pronunciation.hasAnyAudio ||
      pronunciation.hasAnyPhonetic ||
      synonyms.length
  );

  return {
    word: (entry?.word || "").trim(),
    meaning: meaning || "Meaning unavailable for this entry.",
    example: example || "Example sentence unavailable for this entry.",
    synonyms,
    pronunciationText,
    audioUrl,
    pronunciation,
    hasUsefulData
  };
}
