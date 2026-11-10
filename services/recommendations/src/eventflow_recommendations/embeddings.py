"""Pinned CPU embeddings. Only the explicit setup command may download artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import threading
import urllib.request
from pathlib import Path
from typing import Any

from .model_contract import DIMENSIONS, MANIFEST_PATH

MAX_BATCH = 16
MAX_TEXTS = 128
MAX_TEXT_LENGTH = 8000


def model_manifest() -> dict[str, Any]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8-sig"))  # type: ignore[no-any-return]


def _matches(path: Path, spec: dict[str, Any]) -> bool:
    if not path.is_file() or path.stat().st_size != spec["bytes"]:
        return False
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest() == str(spec["sha256"])


def verify_model(model_path: str | Path) -> Path:
    """Fail closed before loading any model with missing or modified artifacts."""
    root = Path(model_path).resolve()
    files = model_manifest()["files"]
    for artifact in root.rglob("*"):
        if artifact.is_file() and artifact.relative_to(root).as_posix() not in files:
            raise ValueError(f"Unpinned model artifact: {artifact.name}")
    for name, spec in files.items():
        if not _matches(root / name, spec):
            raise ValueError(
                f"Model artifact missing or checksum mismatch: {name}; run setup-model"
            )
    return root


def setup_model(model_path: str | Path) -> Path:
    """Explicit, unauthenticated download of exactly the pinned manifest files."""
    root = Path(model_path).resolve()
    root.mkdir(parents=True, exist_ok=True)
    manifest = model_manifest()
    for name, spec in manifest["files"].items():
        target = root / name
        if _matches(target, spec):
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".download")
        url = f"https://huggingface.co/{manifest['modelId']}/resolve/{manifest['revision']}/{name}"
        try:
            with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as out:
                downloaded = 0
                while chunk := response.read(1024 * 1024):
                    downloaded += len(chunk)
                    if downloaded > spec["bytes"]:
                        raise ValueError(f"Oversized model artifact: {name}")
                    out.write(chunk)
            if not _matches(temporary, spec):
                raise ValueError(f"Downloaded artifact checksum mismatch: {name}")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    return verify_model(root)


class LocalEmbedder:
    """Worker-only, bounded, unit-normalized Sentence Transformers CPU inference."""

    def __init__(self, model_path: str | Path, threads: int = 1) -> None:
        if type(threads) is not int or not 1 <= threads <= 8:
            raise ValueError("threads must be an integer between 1 and 8")
        root = verify_model(model_path)
        # Set before importing HF libraries; runtime never authenticates or downloads.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        os.environ["TOKENIZERS_PARALLELISM"] = "false"
        import torch
        from sentence_transformers import SentenceTransformer

        torch.set_num_threads(threads)
        self._model = SentenceTransformer(
            str(root), device="cpu", local_files_only=True, trust_remote_code=False, token=False
        )
        if self._model.get_sentence_embedding_dimension() != DIMENSIONS:
            raise ValueError("Unexpected embedding dimensions")
        self._lock = threading.Lock()

    def encode(self, texts: list[str]) -> list[list[float]]:
        if not isinstance(texts, list) or len(texts) > MAX_TEXTS:
            raise ValueError(f"texts must be a list with at most {MAX_TEXTS} entries")
        if any(
            not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_LENGTH
            for text in texts
        ):
            raise ValueError(f"Each text must be nonempty and at most {MAX_TEXT_LENGTH} characters")
        if not texts:
            return []
        with self._lock:
            rows = self._model.encode(
                texts,
                batch_size=MAX_BATCH,
                show_progress_bar=False,
                normalize_embeddings=True,
                convert_to_numpy=True,
            )
        if len(rows) != len(texts):
            raise ValueError("Unexpected embedding count")
        result = []
        for row in rows:
            vector = [float(value) for value in row]
            if len(vector) != DIMENSIONS or not all(math.isfinite(value) for value in vector):
                raise ValueError("Invalid embedding vector")
            norm = math.sqrt(sum(value * value for value in vector))
            if norm <= 1e-12:
                raise ValueError("Zero embedding vector")
            result.append([value / norm for value in vector])
        return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["setup-model", "verify-model"])
    parser.add_argument("--model-path", type=Path, required=True)
    args = parser.parse_args()
    operation = setup_model if args.command == "setup-model" else verify_model
    print(operation(args.model_path))


if __name__ == "__main__":
    main()
