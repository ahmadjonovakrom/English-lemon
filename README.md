# English Lemon

Modern full-stack MVP for English learning with authentication and vocabulary lookup.

## Tech Stack

- Frontend: React + Vite
- Backend: FastAPI
- Database: SQLite
- Authentication: JWT

## Project Structure

```text
English lemon/
  backend/
    app/
      api/
      core/
      models/
      schemas/
      main.py
    requirements.txt
    .env.example
  frontend/
    src/
      api/
      components/
      context/
      pages/
      App.jsx
      main.jsx
      styles.css
    package.json
    .env.example
  README.md
```

## Backend Setup

```bash
cd backend
python -m venv .venv
```

### Windows

```bash
.venv\Scripts\activate
```

### macOS/Linux

```bash
source .venv/bin/activate
```

```bash
pip install -r requirements.txt
```

Optional environment file:

```bash
copy .env.example .env
```

Run backend:

```bash
python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Backend API base URL: `http://127.0.0.1:8000/api`

## Frontend Setup

```bash
cd frontend
npm install
```

Optional environment file:

```bash
copy .env.example .env
```

Run frontend:

```bash
npm run dev
```

Frontend URL: `http://localhost:5173`

## Production Deployment

The project can deploy as one Docker web service. FastAPI serves the built React app,
API routes, media files, and WebSocket endpoints from the same origin.

Required production environment variables:

```bash
SECRET_KEY=<long-random-secret>
ACCESS_TOKEN_EXPIRE_MINUTES=10080
DATABASE_URL=sqlite:////app/data/english_lemon.db
MEDIA_ROOT=/app/data/media
FRONTEND_DIST_DIR=/app/frontend/dist
```

Build and run locally with Docker:

```bash
docker build -t english-lemon .
docker run --rm -p 8000:8000 -v english-lemon-data:/app/data english-lemon
```

Production URL after Docker run: `http://localhost:8000`

For Render, use the included `render.yaml` blueprint. It provisions a Docker web
service with a persistent disk for SQLite and uploaded voice-message media.

## Auth Endpoints

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`

## Features Included

- Register/login with email + password and JWT auth
- Protected dashboard route
- Logout and token persistence in localStorage
- Vocabulary search via `dictionaryapi.dev` with:
  - Meaning
  - Example sentence
  - Synonyms
  - Pronunciation
- Responsive premium dark navy UI
