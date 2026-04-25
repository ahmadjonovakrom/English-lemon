from pydantic import BaseModel, ConfigDict, EmailStr, Field


class UserBase(BaseModel):
    username: str = Field(min_length=3, max_length=50)
    email: EmailStr


class UserCreate(UserBase):
    password: str = Field(min_length=8, max_length=128)


class UserPublic(UserBase):
    id: int
    display_name: str | None = None
    bio: str | None = None
    avatar_url: str | None = None

    model_config = ConfigDict(from_attributes=True)
