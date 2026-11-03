from __future__ import annotations

import hashlib
import io
import math
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from eventflow_recommendations import embeddings as subject


@pytest.fixture
def model(tmp_path, monkeypatch):
    content = b"pinned artifact"
    (tmp_path / "model.safetensors").write_bytes(content)
    manifest = {
        "modelId": "test/model",
        "revision": "a" * 40,
        "files": {
            "model.safetensors": {
                "bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
        },
    }
    monkeypatch.setattr(subject, "model_manifest", lambda: manifest)
    return tmp_path, content


@pytest.fixture
def fake_model(monkeypatch):
    calls = []

    class FakeModel:
        rows = None

        def __init__(self, *args, **kwargs):
            calls.append((args, kwargs))

        def get_sentence_embedding_dimension(self):
            return 384

        def encode(self, texts, **kwargs):
            calls.append((texts, kwargs))
            return self.rows if self.rows is not None else [[3, 4] + [0] * 382 for _ in texts]

    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(set_num_threads=lambda n: None))
    monkeypatch.setitem(
        sys.modules, "sentence_transformers", SimpleNamespace(SentenceTransformer=FakeModel)
    )
    return FakeModel, calls


def test_runtime_offline_cpu_normalization_and_bounds(model, fake_model, monkeypatch):
    monkeypatch.setenv("HF_HUB_OFFLINE", "0")
    embedder = subject.LocalEmbedder(model[0])
    rows = embedder.encode(["Jazz", "Джаз", "Teatru"])
    assert len(rows) == 3
    assert all(len(row) == 384 for row in rows)
    assert all(math.isclose(sum(v * v for v in row), 1) for row in rows)
    assert rows[0][:2] == [0.6, 0.8]
    calls = fake_model[1]
    assert calls[0][1] == {
        "device": "cpu",
        "local_files_only": True,
        "trust_remote_code": False,
        "token": False,
    }
    assert calls[1][1]["batch_size"] == 16
    assert calls[1][1]["normalize_embeddings"] is True
    assert subject.os.environ["HF_HUB_OFFLINE"] == "1"
    assert subject.os.environ["TRANSFORMERS_OFFLINE"] == "1"
    assert embedder.encode([]) == []


@pytest.mark.parametrize("texts", [[""], ["  "], [1], ["x" * 8001], ["x"] * 129, "x"])
def test_rejects_invalid_input(model, fake_model, texts):
    with pytest.raises(ValueError):
        subject.LocalEmbedder(model[0]).encode(texts)


@pytest.mark.parametrize("threads", [0, 9, True, 1.5])
def test_rejects_invalid_thread_count(model, threads):
    with pytest.raises(ValueError, match="threads"):
        subject.LocalEmbedder(model[0], threads=threads)


@pytest.mark.parametrize("rows", [[[0] * 384], [[float("nan")] * 384], [[1] * 383], []])
def test_rejects_malformed_model_output(model, fake_model, rows):
    fake_model[0].rows = rows
    with pytest.raises(ValueError):
        subject.LocalEmbedder(model[0]).encode(["Jazz"])


def test_missing_or_tampered_model_fails_before_library_import(model):
    path = model[0] / "model.safetensors"
    path.write_bytes(b"tampered model!")
    with pytest.raises(ValueError, match="checksum"):
        subject.LocalEmbedder(model[0])
    path.unlink()
    with pytest.raises(ValueError, match="missing"):
        subject.verify_model(model[0])


def test_setup_downloads_only_pinned_revision_and_reuses_verified(model, monkeypatch):
    root, content = model
    (root / "model.safetensors").unlink()
    calls = []

    def fetch(url, *, timeout):
        calls.append(url)
        assert timeout == 120
        return io.BytesIO(content)

    monkeypatch.setattr(subject.urllib.request, "urlopen", fetch)
    assert subject.setup_model(root) == root
    assert calls == [f"https://huggingface.co/test/model/resolve/{'a' * 40}/model.safetensors"]
    subject.setup_model(root)
    assert len(calls) == 1


def test_setup_rejects_corrupt_download_and_cleans_partial(model, monkeypatch):
    root, _ = model
    (root / "model.safetensors").unlink()
    monkeypatch.setattr(subject.urllib.request, "urlopen", lambda *a, **k: io.BytesIO(b"bad"))
    with pytest.raises(ValueError, match="checksum"):
        subject.setup_model(root)
    assert not (root / "model.safetensors").exists()
    assert not (root / "model.safetensors.download").exists()


def test_real_manifest_is_immutable_and_complete():
    manifest = subject.model_manifest()
    assert manifest["dimensions"] == 384
    assert manifest["languages"] == ["ru", "ro", "en"]
    assert len(manifest["revision"]) == 40
    assert "model.safetensors" in manifest["files"]
    assert "modules.json" in manifest["files"]
    for name, item in manifest["files"].items():
        assert not Path(name).is_absolute() and ".." not in Path(name).parts
        assert len(item["sha256"]) == 64
        assert item["bytes"] > 0


def test_runtime_rejects_unpinned_local_configuration(model):
    (model[0] / "adapter_config.json").write_text("{}")
    with pytest.raises(ValueError, match="Unpinned"):
        subject.LocalEmbedder(model[0])
