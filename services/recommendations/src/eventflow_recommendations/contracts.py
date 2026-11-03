from datetime import date
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

Position = Annotated[int, Field(strict=True, ge=0, le=9_007_199_254_740_991)]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceDocument(Contract):
    id: UUID
    title: Annotated[str, Field(min_length=2, max_length=160)]
    description: Annotated[str, Field(max_length=5000)]
    city: Annotated[str, Field(min_length=1, max_length=100)]
    address: Annotated[str, Field(min_length=1, max_length=300)]
    time_zone: Annotated[str, Field(alias="timeZone", min_length=1, max_length=100)]
    starts_at: Annotated[AwareDatetime, Field(alias="startsAt")]
    ends_at: Annotated[AwareDatetime, Field(alias="endsAt")]
    local_date: Annotated[date, Field(alias="localDate")]
    min_price_minor: Annotated[int, Field(alias="minPriceMinor", strict=True, ge=0, le=100_000_000)]
    currency: Literal["EUR"]
    capacity: Annotated[int, Field(strict=True, ge=1, le=1_000_000)]
    cover_id: Annotated[UUID | None, Field(alias="coverId")]


class SourceChange(Contract):
    position: Annotated[int, Field(strict=True, ge=1, le=9_007_199_254_740_991)]
    event_id: Annotated[UUID, Field(alias="eventId")]
    document: SourceDocument | None

    @model_validator(mode="after")
    def identity(self) -> Self:
        if self.document and self.document.id != self.event_id:
            raise ValueError("Source document identity mismatch")
        return self


class SourcePage(Contract):
    changes: Annotated[list[SourceChange], Field(max_length=100)]
    through: Position
    next: Position
