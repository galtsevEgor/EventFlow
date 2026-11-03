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


class RecommendationFilters(Contract):
    city: Annotated[str, Field(max_length=100)] = ""
    from_date: Annotated[date | None, Field(alias="from")] = None
    to_date: Annotated[date | None, Field(alias="to")] = None
    min_price_minor: Annotated[int | None, Field(alias="minPriceMinor", ge=0, le=100_000_000)] = (
        None
    )
    max_price_minor: Annotated[int | None, Field(alias="maxPriceMinor", ge=0, le=100_000_000)] = (
        None
    )
    limit: Annotated[int, Field(ge=1, le=12)] = 6

    @model_validator(mode="after")
    def ranges(self) -> Self:
        if self.from_date and self.to_date and self.from_date > self.to_date:
            raise ValueError("Invalid date range")
        if (
            self.min_price_minor is not None
            and self.max_price_minor is not None
            and self.min_price_minor > self.max_price_minor
        ):
            raise ValueError("Invalid price range")
        self.city = self.city.strip()
        return self


class RecommendationItem(Contract):
    event: SourceDocument
    reason: Literal["SIMILAR", "INTERESTS", "FAVORITES", "UPCOMING"]


class RecommendationPage(Contract):
    items: Annotated[list[RecommendationItem], Field(max_length=12)]
    mode: Literal["similar", "personal", "upcoming"]
    degraded: bool


class RecommendationError(Contract):
    code: str
    message: str
    requestId: str
    retryable: bool
