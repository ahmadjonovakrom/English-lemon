import { useState } from "react";

const CATEGORY_OPTIONS = [
  "Mixed",
  "Vocabulary",
  "Grammar",
  "Idioms and Phrases",
  "Synonyms",
  "Collocations"
];

const DIFFICULTY_OPTIONS = ["Easy", "Medium", "Hard"];

function CreateRoomModal({ open, loading, error, onClose, onCreate }) {
  const [form, setForm] = useState({
    title: "Quiz Arena",
    category: "Mixed",
    difficulty: "Medium",
    question_count: 5,
    max_players: 4
  });

  if (!open) {
    return null;
  }

  const handleSubmit = (event) => {
    event.preventDefault();
    onCreate({
      ...form,
      question_count: Number(form.question_count),
      max_players: Number(form.max_players)
    });
  };

  return (
    <div className="multiplayer-modal-overlay" role="presentation">
      <section className="multiplayer-modal" role="dialog" aria-modal="true">
        <header className="multiplayer-modal-header">
          <div>
            <p className="brand-mark">English Lemon</p>
            <h2>Create Multiplayer Room</h2>
          </div>
          <button type="button" className="secondary-btn" onClick={onClose} disabled={loading}>
            Close
          </button>
        </header>

        <form className="multiplayer-modal-form" onSubmit={handleSubmit}>
          <label>
            Room Title
            <input
              value={form.title}
              onChange={(event) => setForm((previous) => ({ ...previous, title: event.target.value }))}
              maxLength={140}
              disabled={loading}
            />
          </label>

          <label>
            Category
            <select
              value={form.category}
              onChange={(event) => setForm((previous) => ({ ...previous, category: event.target.value }))}
              disabled={loading}
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <label>
            Difficulty
            <select
              value={form.difficulty}
              onChange={(event) => setForm((previous) => ({ ...previous, difficulty: event.target.value }))}
              disabled={loading}
            >
              {DIFFICULTY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>

          <div className="multiplayer-modal-grid">
            <label>
              Questions
              <input
                type="number"
                min="3"
                max="10"
                value={form.question_count}
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, question_count: event.target.value }))
                }
                disabled={loading}
              />
            </label>

            <label>
              Max Players
              <input
                type="number"
                min="2"
                max="12"
                value={form.max_players}
                onChange={(event) =>
                  setForm((previous) => ({ ...previous, max_players: event.target.value }))
                }
                disabled={loading}
              />
            </label>
          </div>

          {error ? <p className="error-text">{error}</p> : null}

          <div className="multiplayer-modal-actions">
            <button type="button" className="secondary-btn" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button type="submit" className="primary-btn" disabled={loading || !form.title.trim()}>
              {loading ? "Creating..." : "Create Room"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export default CreateRoomModal;
