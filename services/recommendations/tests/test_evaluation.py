from __future__ import annotations

import copy
import json
import math
import socket

import pytest

from eventflow_recommendations.benchmark import (
    latency_summary,
    performance_vectors,
    plan_nodes,
    verify_local_database_urls,
)
from eventflow_recommendations.evaluation import (
    Corpus,
    deny_inference_network,
    evaluate,
    lexical_score,
    load_corpus,
    metrics,
)


def test_ndcg_and_recall_perfect_partial_and_no_matches():
    assert metrics(["a", "b"], {"a", "b"}) == {"ndcgAt5": 1, "recallAt5": 1}
    actual = metrics(["wrong", "a", "b"], {"a", "b"})
    expected = (1 / math.log2(3) + 1 / math.log2(4)) / (1 + 1 / math.log2(3))
    assert actual["ndcgAt5"] == pytest.approx(expected)
    assert actual["recallAt5"] == 1
    assert metrics(["wrong"], {"a"}) == {"ndcgAt5": 0, "recallAt5": 0}
    assert metrics(["a", "x", "y", "z", "w", "b"], {"a", "b"})["recallAt5"] == 0.5


@pytest.mark.parametrize(
    "ranking,relevant,k",
    [
        (["a", "a"], {"a"}, 5),
        (["a"], set(), 5),
        (["a"], {"a"}, 0),
    ],
)
def test_metrics_reject_inflated_or_undefined_rankings(ranking, relevant, k):
    with pytest.raises(ValueError):
        metrics(ranking, relevant, k)


def test_honest_lexical_tf_cosine_unicode_and_no_hidden_translation():
    assert lexical_score("a a b", "a b b") == pytest.approx(0.8)
    assert lexical_score("ДЖАЗ!", "джаз") == 1
    assert lexical_score("păpuși", "PĂPUȘI") == 1
    assert lexical_score("theatre", "театр") == 0
    assert lexical_score("!!!", "???") == 0


def test_fixed_fixture_complete_synthetic_topic_and_language_labels():
    corpus = load_corpus()
    assert corpus.synthetic and corpus.protocol == "cross-language-topic-relevance"
    assert len(corpus.events) == len(corpus.queries) == 36
    for query in corpus.queries:
        relevant = [
            event
            for event in corpus.events
            if event.topic == query.topic and event.language != query.language
        ]
        assert len(relevant) == 2
        assert len({event.language for event in relevant}) == 2


@pytest.mark.parametrize(
    "mutation",
    [
        "duplicate-id",
        "unknown-topic",
        "wrong-language",
        "nonsynthetic",
        "extra-field",
        "missing-event",
        "short-text",
    ],
)
def test_fixture_invalid_labels_and_unknown_fields_fail_closed(mutation):
    value = copy.deepcopy(load_corpus().model_dump())
    if mutation == "duplicate-id":
        value["events"][1]["id"] = value["events"][0]["id"]
    elif mutation == "unknown-topic":
        value["queries"][0]["topic"] = "unlabeled"
    elif mutation == "wrong-language":
        value["events"][0]["language"] = "de"
    elif mutation == "nonsynthetic":
        value["synthetic"] = False
    elif mutation == "extra-field":
        value["privateActor"] = "not-allowed"
    elif mutation == "missing-event":
        value["events"].pop()
    else:
        value["queries"][0]["text"] = ""
    with pytest.raises(ValueError):
        Corpus.model_validate_json(json.dumps(value))


def topic_vectors(corpus):
    topics = sorted({event.topic for event in corpus.events})

    def vector(topic):
        values = [0.0] * 384
        values[topics.index(topic)] = 1.0
        return values

    return (
        [vector(event.topic) for event in corpus.events],
        [vector(query.topic) for query in corpus.queries],
    )


def test_quality_gate_deterministic_language_metrics_and_failed_quality_not_relaxed():
    corpus = load_corpus()
    event_vectors, query_vectors = topic_vectors(corpus)
    result = evaluate(corpus, event_vectors, query_vectors)
    assert result["passed"]
    assert result["overall"]["semantic"] == {"ndcgAt5": 1, "recallAt5": 1}
    assert set(result["byQueryLanguage"]) == {"ru", "ro", "en"}
    assert evaluate(corpus, event_vectors, query_vectors) == result
    failed = evaluate(corpus, event_vectors, query_vectors[3:] + query_vectors[:3])
    assert not failed["passed"]
    assert failed["thresholdNdcgAt5"] == 0.8


@pytest.mark.parametrize("mode", ["count", "dimension", "nan", "not-normalized"])
def test_evaluation_rejects_invalid_vectors(mode):
    corpus = load_corpus()
    events, queries = topic_vectors(corpus)
    if mode == "count":
        queries.pop()
    elif mode == "dimension":
        queries[0] = [1.0]
    elif mode == "nan":
        queries[0][0] = float("nan")
    else:
        queries[0] = [1.0] * 384
    with pytest.raises(ValueError):
        evaluate(corpus, events, queries)


def test_inference_network_denial_restores_socket_for_database_benchmark():
    original_connect = socket.socket.connect
    original_create = socket.create_connection
    with deny_inference_network():
        with pytest.raises(RuntimeError, match="network"):
            socket.create_connection(("127.0.0.1", 1))
        with socket.socket() as connection, pytest.raises(RuntimeError, match="network"):
            connection.connect(("127.0.0.1", 1))
    assert socket.socket.connect is original_connect
    assert socket.create_connection is original_create


def test_performance_corpus_is_seeded_perturbation_not_quality_labels():
    base = [[1.0] + [0.0] * 383]
    vectors = performance_vectors(base, count=7)
    assert len(vectors) == 7 and vectors == performance_vectors(base, count=7)
    assert vectors[0] != base[0] and vectors[0] != vectors[1]
    assert all(sum(value * value for value in vector) == pytest.approx(1) for vector in vectors)


def test_plan_inspection_and_nearest_rank_latency_percentiles():
    plan = {"Node Type": "Limit", "Plans": [{"Node Type": "Index Scan", "Index Name": "hnsw"}]}
    assert [node["Node Type"] for node in plan_nodes(plan)] == ["Limit", "Index Scan"]
    assert latency_summary(list(range(1, 101))) == {"p50Ms": 50.5, "p95Ms": 95}


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://u:p@127.0.0.1:25432/original",
        "postgresql://u:p@remote.invalid:26432/db",
        "",
        "http://127.0.0.1:26432/db",
    ],
)
def test_benchmark_never_targets_original_or_remote_database(url):
    with pytest.raises(ValueError):
        verify_local_database_urls(url, url)
