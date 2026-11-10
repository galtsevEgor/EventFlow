"""Fixed synthetic cross-language quality gate and isolated vector-search benchmark."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import socket
import statistics
import time
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Literal
from unittest.mock import patch

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .interests import INTEREST_IDS
from .model_contract import DIMENSIONS

FIXTURE = Path(__file__).resolve().parents[2] / "tests/fixtures/recommendations.json"
LANGUAGES = ("ru", "ro", "en")
MIN_NDCG = 0.8


class LabeledText(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=100)
    topic: str
    language: Literal["ru", "ro", "en"]
    text: str = Field(min_length=10, max_length=1000)


class Corpus(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    synthetic: Literal[True]
    protocol: Literal["cross-language-topic-relevance"]
    events: list[LabeledText] = Field(min_length=36, max_length=36)
    queries: list[LabeledText] = Field(min_length=36, max_length=36)

    @model_validator(mode="after")
    def complete(self) -> Corpus:
        expected = {(topic, language) for topic in INTEREST_IDS for language in LANGUAGES}
        for rows in (self.events, self.queries):
            if len({row.id for row in rows}) != len(rows):
                raise ValueError("Duplicate fixture identity")
            if {(row.topic, row.language) for row in rows} != expected:
                raise ValueError("Fixture must cover every topic and language exactly once")
        return self


def load_corpus(path: Path = FIXTURE) -> Corpus:
    return Corpus.model_validate_json(path.read_text(encoding="utf-8"))


def metrics(ranked: list[str], relevant: set[str], k: int = 5) -> dict[str, float]:
    if k < 1 or not relevant or len(set(ranked)) != len(ranked):
        raise ValueError(
            "Metrics require positive k, relevance labels and unique ranked identities"
        )
    dcg = sum(1 / math.log2(rank + 2) for rank, id in enumerate(ranked[:k]) if id in relevant)
    ideal = sum(1 / math.log2(rank + 2) for rank in range(min(k, len(relevant))))
    return {"ndcgAt5": dcg / ideal, "recallAt5": len(set(ranked[:k]) & relevant) / len(relevant)}


def lexical_score(query: str, document: str) -> float:
    """Honest untrained baseline: cosine of Unicode word-token term frequencies."""
    left = Counter(re.findall(r"[^\W_]+", query.casefold()))
    right = Counter(re.findall(r"[^\W_]+", document.casefold()))
    norm = math.sqrt(sum(v * v for v in left.values()) * sum(v * v for v in right.values()))
    return sum(value * right[word] for word, value in left.items()) / norm if norm else 0.0


def evaluate(
    corpus: Corpus, event_vectors: list[list[float]], query_vectors: list[list[float]]
) -> dict[str, Any]:
    if len(event_vectors) != len(corpus.events) or len(query_vectors) != len(corpus.queries):
        raise ValueError("Vector count differs from labeled corpus")
    for vector in [*event_vectors, *query_vectors]:
        if len(vector) != DIMENSIONS or not all(math.isfinite(v) for v in vector):
            raise ValueError("Invalid evaluation vector")
        if abs(sum(v * v for v in vector) - 1) > 1e-5:
            raise ValueError("Evaluation vectors must be unit normalized")
    rows = []
    for query, vector in zip(corpus.queries, query_vectors, strict=True):
        candidates = [
            i for i, event in enumerate(corpus.events) if event.language != query.language
        ]
        relevant = {
            corpus.events[i].id for i in candidates if corpus.events[i].topic == query.topic
        }
        semantic = sorted(
            candidates,
            key=lambda i: (
                -sum(a * b for a, b in zip(vector, event_vectors[i], strict=True)),
                corpus.events[i].id,
            ),
        )
        lexical = sorted(
            candidates,
            key=lambda i: (-lexical_score(query.text, corpus.events[i].text), corpus.events[i].id),
        )
        semantic_ids = [corpus.events[i].id for i in semantic]
        lexical_ids = [corpus.events[i].id for i in lexical]
        rows.append(
            {
                "queryId": query.id,
                "language": query.language,
                "semantic": metrics(semantic_ids, relevant),
                "lexical": metrics(lexical_ids, relevant),
                "semanticTop5": semantic_ids[:5],
                "lexicalTop5": lexical_ids[:5],
            }
        )

    def average(group: list[dict[str, Any]], method: str) -> dict[str, float]:
        return {
            name: statistics.mean(row[method][name] for row in group)
            for name in ("ndcgAt5", "recallAt5")
        }

    overall = {method: average(rows, method) for method in ("semantic", "lexical")}
    languages = {
        language: {
            method: average([row for row in rows if row["language"] == language], method)
            for method in ("semantic", "lexical")
        }
        for language in LANGUAGES
    }
    passed = (
        overall["semantic"]["ndcgAt5"] >= MIN_NDCG
        and (overall["semantic"]["ndcgAt5"] > overall["lexical"]["ndcgAt5"])
        and all(language["semantic"]["ndcgAt5"] >= MIN_NDCG for language in languages.values())
    )
    return {
        "passed": passed,
        "thresholdNdcgAt5": MIN_NDCG,
        "overall": overall,
        "byQueryLanguage": languages,
        "queries": rows,
    }


@contextmanager
def deny_inference_network() -> Iterator[None]:
    def denied(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("Inference attempted network access")

    with (
        patch.object(socket.socket, "connect", denied),
        patch.object(socket, "create_connection", denied),
    ):
        yield


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--benchmark", action="store_true")
    args = parser.parse_args()
    import psutil  # type: ignore[import-untyped]

    from .embeddings import LocalEmbedder, model_manifest
    from .runtime import run

    corpus = load_corpus()
    started = time.perf_counter()
    with deny_inference_network():
        embedder = LocalEmbedder(args.model_path, threads=1)
        loaded = time.perf_counter()
        event_vectors = embedder.encode([event.text for event in corpus.events])
        query_vectors = embedder.encode([query.text for query in corpus.queries])
        inferred = time.perf_counter()
    result = {
        "synthetic": True,
        "protocol": corpus.protocol,
        "sameLanguageCandidatesExcluded": True,
        "events": len(corpus.events),
        "queries": len(corpus.queries),
        "topics": len(INTEREST_IDS),
        "model": model_manifest()["modelId"],
        "revision": model_manifest()["revision"],
        "fixtureSha256": hashlib.sha256(FIXTURE.read_bytes()).hexdigest(),
        "modelThreads": 1,
        "runtimeNetworkDenied": True,
        "modelLoadSeconds": loaded - started,
        "embeddingSeconds": inferred - loaded,
        "rssBytes": psutil.Process().memory_info().rss,
        "quality": evaluate(corpus, event_vectors, query_vectors),
    }
    if args.benchmark:
        from .benchmark import BenchmarkError, benchmark

        async def execute() -> None:
            result["benchmark"] = await benchmark(event_vectors, query_vectors)

        try:
            run(execute())
            memory = psutil.Process().memory_info()
            result["rssBytesAfterBenchmark"] = memory.rss
            result["peakWorkingSetBytes"] = getattr(memory, "peak_wset", None)
        except Exception as error:
            result["benchmark"] = {"passed": False, "errorType": type(error).__name__}
            if isinstance(error, BenchmarkError):
                result["benchmark"]["diagnostic"] = str(error)
    serialized = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        destination = args.output.resolve()
        root = Path(__file__).resolve().parents[4] / "work"
        if not destination.is_relative_to(root):
            raise ValueError("Evaluation output must stay in ignored repository work directory")
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(serialized, encoding="utf-8")
    print(serialized, end="")
    if not result["quality"]["passed"] or not result.get("benchmark", {"passed": True})["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
