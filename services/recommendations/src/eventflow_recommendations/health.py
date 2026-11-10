"""Shared readiness policy for the recommendation projection."""

PROJECTION_MAX_AGE_SECONDS = 45


def projection_is_ready(active: bool, heartbeat_age_seconds: float | None) -> bool:
    return (
        active
        and heartbeat_age_seconds is not None
        and heartbeat_age_seconds < PROJECTION_MAX_AGE_SECONDS
    )
