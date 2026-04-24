from fastapi import Depends
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import credentials_exception, decode_access_token
from app.models.user import User


oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def get_current_user(
    token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)
) -> User:
    subject = decode_access_token(token)
    try:
        user_id = int(subject)
    except ValueError as exc:
        raise credentials_exception() from exc

    user = db.get(User, user_id)
    if not user:
        raise credentials_exception()
    return user
