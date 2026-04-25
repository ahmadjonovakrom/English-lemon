from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class NotificationItem(BaseModel):
    id: int
    type: str
    title: str
    message: str
    is_read: bool
    created_at: datetime
    related_user_id: int | None = None
    related_entity_id: int | None = None
    related_entity_type: str | None = None
    metadata: dict[str, Any] | None = None


class NotificationListResponse(BaseModel):
    notifications: list[NotificationItem] = Field(default_factory=list)
    unread_count: int = 0


class NotificationUnreadCountResponse(BaseModel):
    unread_count: int = 0


class NotificationActionResponse(BaseModel):
    detail: str
