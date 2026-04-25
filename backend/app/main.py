from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect, text

from app.api.routes.auth import router as auth_router
from app.api.routes.multiplayer import router as multiplayer_router
from app.api.routes.notifications import router as notifications_router
from app.api.routes.presence import router as presence_router
from app.api.routes.signaling import router as signaling_router
from app.api.routes.social import router as social_router
from app.api.routes.users import router as users_router
from app.core.config import settings
from app.core.database import Base, engine
from app import models  # noqa: F401


app = FastAPI(title=settings.APP_NAME, version="1.0.0")
BACKEND_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_ROOT.parent
MEDIA_ROOT = Path(settings.MEDIA_ROOT).resolve() if settings.MEDIA_ROOT else BACKEND_ROOT / "media"
FRONTEND_DIST = (
    Path(settings.FRONTEND_DIST_DIR).resolve()
    if settings.FRONTEND_DIST_DIR
    else PROJECT_ROOT / "frontend" / "dist"
)
MEDIA_ROOT.mkdir(parents=True, exist_ok=True)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_origin_regex=settings.CORS_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)
    ensure_presence_columns()
    ensure_challenge_columns()


def ensure_presence_columns():
    inspector = inspect(engine)
    columns = {column["name"] for column in inspector.get_columns("users")}
    statements = []
    if "is_online" not in columns:
        statements.append("ALTER TABLE users ADD COLUMN is_online BOOLEAN NOT NULL DEFAULT 0")
    if "in_call" not in columns:
        statements.append("ALTER TABLE users ADD COLUMN in_call BOOLEAN NOT NULL DEFAULT 0")
    if "last_seen" not in columns:
        statements.append("ALTER TABLE users ADD COLUMN last_seen DATETIME")
    if "display_name" not in columns:
        statements.append("ALTER TABLE users ADD COLUMN display_name VARCHAR(80)")
    if "bio" not in columns:
        statements.append("ALTER TABLE users ADD COLUMN bio TEXT")
    if "avatar_url" not in columns:
        statements.append("ALTER TABLE users ADD COLUMN avatar_url VARCHAR(600)")
    if not statements:
        return
    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))


def ensure_challenge_columns():
    inspector = inspect(engine)
    columns = {column["name"] for column in inspector.get_columns("challenges")}
    statements = []
    if "challenge_type" not in columns:
        statements.append(
            "ALTER TABLE challenges ADD COLUMN challenge_type VARCHAR(40) NOT NULL DEFAULT 'quick_quiz'"
        )
    if "challenger_score" not in columns:
        statements.append("ALTER TABLE challenges ADD COLUMN challenger_score INTEGER")
    if "challenged_score" not in columns:
        statements.append("ALTER TABLE challenges ADD COLUMN challenged_score INTEGER")
    if "winner_id" not in columns:
        statements.append("ALTER TABLE challenges ADD COLUMN winner_id INTEGER")
    if "started_at" not in columns:
        statements.append("ALTER TABLE challenges ADD COLUMN started_at DATETIME")
    if "completed_at" not in columns:
        statements.append("ALTER TABLE challenges ADD COLUMN completed_at DATETIME")
    if not statements:
        return
    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))


@app.get("/health")
def health_check():
    return {"status": "ok"}


app.mount("/media", StaticFiles(directory=MEDIA_ROOT), name="media")

app.include_router(auth_router, prefix=settings.API_PREFIX)
app.include_router(multiplayer_router, prefix=settings.API_PREFIX)
app.include_router(users_router, prefix=settings.API_PREFIX)
app.include_router(social_router, prefix=settings.API_PREFIX)
app.include_router(signaling_router, prefix=settings.API_PREFIX)
app.include_router(notifications_router, prefix=settings.API_PREFIX)
app.include_router(presence_router, prefix=settings.API_PREFIX)

if FRONTEND_DIST.exists():
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="frontend-assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_frontend(full_path: str):
        requested_path = (FRONTEND_DIST / full_path).resolve()
        try:
            requested_path.relative_to(FRONTEND_DIST)
        except ValueError:
            return FileResponse(FRONTEND_DIST / "index.html")
        if requested_path.is_file():
            return FileResponse(requested_path)
        return FileResponse(FRONTEND_DIST / "index.html")
