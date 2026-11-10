"""Pinned model manifest location, dimensions, and repository-relative paths."""

import json
from pathlib import Path

MANIFEST_PATH = Path(__file__).resolve().parents[2] / "model.json"
REPOSITORY_ROOT = MANIFEST_PATH.parents[2]
MODEL_MANIFEST = json.loads(MANIFEST_PATH.read_text(encoding="utf-8-sig"))
DIMENSIONS = int(MODEL_MANIFEST["dimensions"])


def resolve_model_path(value: str | Path) -> Path:
    path = Path(value)
    return (path if path.is_absolute() else REPOSITORY_ROOT / path).resolve()


def default_model_path() -> Path:
    return resolve_model_path(MODEL_MANIFEST["localPath"])
