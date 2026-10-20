"""Unit tests for ml/tools/validate_kb.py."""

import copy
import json
import os
import tempfile
import pytest

from ml.tools.validate_kb import validate_kb

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
REAL_KB_PATH = os.path.join(ROOT_DIR, "ml", "data", "chat_outputs", "kb", "kb_batch_01.json")


@pytest.fixture
def real_kb_data():
    with open(REAL_KB_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def test_validate_kb_real_file_passes():
    """Verify the real production KB file passes all validation checks."""
    report = validate_kb(REAL_KB_PATH)
    assert report["total_objects"] == 30
    assert report["ids_range"] == "KB-001..KB-030"
    assert report["banned_words_found"] == 0
    assert len(report["families"]) == 6
    for fam, cnt in report["families"].items():
        assert cnt == 5
    for fam, sim in report["family_max_similarities"].items():
        assert sim <= 0.6


def test_validate_kb_catches_wrong_count(real_kb_data, tmp_path):
    """Verify validator catches files with not exactly 30 items."""
    bad_data = real_kb_data[:29]  # 29 items
    temp_file = tmp_path / "bad_count.json"
    temp_file.write_text(json.dumps(bad_data), encoding="utf-8")

    with pytest.raises(ValueError, match="Expected exactly 30 objects"):
        validate_kb(str(temp_file))


def test_validate_kb_catches_bad_ids(real_kb_data, tmp_path):
    """Verify validator catches out-of-order or invalid IDs."""
    bad_data = copy.deepcopy(real_kb_data)
    bad_data[0]["id"] = "KB-999"
    temp_file = tmp_path / "bad_ids.json"
    temp_file.write_text(json.dumps(bad_data), encoding="utf-8")

    with pytest.raises(ValueError, match="IDs do not match KB-001..KB-030"):
        validate_kb(str(temp_file))


def test_validate_kb_catches_missing_field(real_kb_data, tmp_path):
    """Verify validator catches missing required fields."""
    bad_data = copy.deepcopy(real_kb_data)
    del bad_data[0]["root_cause"]
    temp_file = tmp_path / "missing_field.json"
    temp_file.write_text(json.dumps(bad_data), encoding="utf-8")

    with pytest.raises(ValueError, match="Required field violations"):
        validate_kb(str(temp_file))


def test_validate_kb_catches_empty_field(real_kb_data, tmp_path):
    """Verify validator catches empty or whitespace-only fields."""
    bad_data = copy.deepcopy(real_kb_data)
    bad_data[2]["title"] = "   "
    temp_file = tmp_path / "empty_field.json"
    temp_file.write_text(json.dumps(bad_data), encoding="utf-8")

    with pytest.raises(ValueError, match="empty or whitespace only"):
        validate_kb(str(temp_file))


def test_validate_kb_catches_banned_words(real_kb_data, tmp_path):
    """Verify validator catches banned words like 'critical', 'urgent', 'sev1'."""
    bad_data = copy.deepcopy(real_kb_data)
    bad_data[5]["symptoms"] += " This is a critical urgent blocker."
    temp_file = tmp_path / "banned_words.json"
    temp_file.write_text(json.dumps(bad_data), encoding="utf-8")

    with pytest.raises(ValueError, match="Banned words detected"):
        validate_kb(str(temp_file))


def test_validate_kb_catches_imbalanced_families(real_kb_data, tmp_path):
    """Verify validator catches family distribution mismatch."""
    bad_data = copy.deepcopy(real_kb_data)
    # Change one login_failure to upload_failure
    bad_data[0]["family"] = "upload_failure"
    temp_file = tmp_path / "bad_family.json"
    temp_file.write_text(json.dumps(bad_data), encoding="utf-8")

    with pytest.raises(ValueError, match="Family distribution violations"):
        validate_kb(str(temp_file))


def test_validate_kb_catches_high_root_cause_similarity(real_kb_data, tmp_path):
    """Verify validator flags any pair within a family with TF-IDF cosine > 0.6."""
    bad_data = copy.deepcopy(real_kb_data)
    # Duplicate root_cause between KB-001 and KB-002 (both login_failure)
    bad_data[1]["root_cause"] = bad_data[0]["root_cause"]
    temp_file = tmp_path / "duplicate_rc.json"
    temp_file.write_text(json.dumps(bad_data), encoding="utf-8")

    with pytest.raises(ValueError, match="TF-IDF root cause distinctness violations"):
        validate_kb(str(temp_file))
