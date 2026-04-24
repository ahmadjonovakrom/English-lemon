import os

from dotenv import load_dotenv


load_dotenv()


class Settings:
    APP_NAME: str = "English Lemon API"
    API_PREFIX: str = "/api"
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./english_lemon.db")
    MEDIA_ROOT: str = os.getenv("MEDIA_ROOT", "")
    FRONTEND_DIST_DIR: str = os.getenv("FRONTEND_DIST_DIR", "")
    SECRET_KEY: str = os.getenv("SECRET_KEY", "change-this-in-production")
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(
        os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "10080")
    )
    CORS_ORIGINS: list[str] = [
        origin.strip()
        for origin in os.getenv(
            "CORS_ORIGINS",
            "http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174",
        ).split(",")
        if origin.strip()
    ]


settings = Settings()
