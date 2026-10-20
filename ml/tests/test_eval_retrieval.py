"""Unit tests for retrieval metrics and query validation."""

import copy
import json
import os
import pytest

from ml.eval_retrieval import (
    compute_recall_at_k,
    compute_mrr,
    compute_sibling_confusion,
    compute_cross_family_error,
    compute_all_metrics,
)
from ml.tools.validate_queries import (
    validate_queries,
    longest_common_consecutive_run,
    tokenize_words,
)

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
REAL_QUERIES_PATH = os.path.join(ROOT_DIR, "ml", "data", "retrieval_queries.json")
REAL_KB_PATH = os.path.join(ROOT_DIR, "ml", "data", "chat_outputs", "kb", "kb_batch_01.json")


# =====================================================================
# 1. Metric Unit Tests with Hand-Made Known Answers
# =====================================================================

def test_recall_at_k_known_answers():
    # 3 queries
    # Q1: target 'A' is at rank 1
    # Q2: target 'B' is at rank 2
    # Q3: target 'C' is at rank 3
    # Q4: target 'D' is at rank 4 (not in top 3)
    ranked = [
        ["A", "X", "Y"],
        ["X", "B", "Y"],
        ["X", "Y", "C"],
        ["X", "Y", "Z", "D"],
    ]
    expected = ["A", "B", "C", "D"]

    # Recall@1: only Q1 hits -> 1/4 = 0.25
    assert compute_recall_at_k(ranked, expected, 1) == 0.25

    # Recall@2: Q1, Q2 hit -> 2/4 = 0.50
    assert compute_recall_at_k(ranked, expected, 2) == 0.50

    # Recall@3: Q1, Q2, Q3 hit -> 3/4 = 0.75
    assert compute_recall_at_k(ranked, expected, 3) == 0.75

    # Recall@4: Q1, Q2, Q3, Q4 hit -> 4/4 = 1.0
    assert compute_recall_at_k(ranked, expected, 4) == 1.0


def test_mrr_known_answers():
    # Q1: target 'A' at rank 1 -> RR = 1/1 = 1.0
    # Q2: target 'B' at rank 2 -> RR = 1/2 = 0.5
    # Q3: target 'C' at rank 4 -> RR = 1/4 = 0.25
    # Q4: target 'D' not found -> RR = 0.0
    ranked = [
        ["A", "X"],
        ["X", "B"],
        ["X", "Y", "Z", "C"],
        ["X", "Y", "Z"],
    ]
    expected = ["A", "B", "C", "D"]

    # MRR = (1.0 + 0.5 + 0.25 + 0.0) / 4 = 1.75 / 4 = 0.4375
    assert compute_mrr(ranked, expected) == 0.4375


def test_sibling_confusion_and_cross_family_known_answers():
    # id_to_family mapping
    families = {
        "A1": "login",
        "A2": "login",
        "B1": "upload",
        "B2": "upload",
    }

    # 3 queries:
    # Q1: expected 'A1' (login), top-1 is 'A1' -> Correct
    # Q2: expected 'A1' (login), top-1 is 'A2' (login) -> Sibling confusion (same family)
    # Q3: expected 'A1' (login), top-1 is 'B1' (upload) -> Cross-family error
    ranked = [
        ["A1", "B1"],
        ["A2", "A1"],
        ["B1", "A1"],
    ]
    expected = ["A1", "A1", "A1"]

    metrics = compute_all_metrics(ranked, expected, families)

    assert metrics["recall_at_1"] == pytest.approx(1.0 / 3.0)
    assert metrics["sibling_confusion_rate"] == pytest.approx(1.0 / 3.0)
    assert metrics["cross_family_error_rate"] == pytest.approx(1.0 / 3.0)
    assert metrics["recall_at_3"] == 1.0
    # The sum of R@1, sibling confusion, and cross-family error must equal exactly 1.0
    assert metrics["recall_at_1"] + metrics["sibling_confusion_rate"] + metrics["cross_family_error_rate"] == pytest.approx(1.0)


def test_consecutive_word_run_helper():
    tok_a = tokenize_words("The quick brown fox jumps over the lazy dog")
    tok_b = tokenize_words("a quick brown fox leaps")
    run_len, phrase = longest_common_consecutive_run(tok_a, tok_b)
    assert run_len == 3
    assert phrase == ["quick", "brown", "fox"]


# =====================================================================
# 2. validate_queries Unit Tests
# =====================================================================

@pytest.fixture
def real_queries_data():
    with open(REAL_QUERIES_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def test_validate_queries_real_file_passes():
    """Real query file passes structural validation."""
    summary = validate_queries(REAL_QUERIES_PATH, kb_path=REAL_KB_PATH)
    assert summary["total_queries"] == 15
    assert summary["query_ids_range"] == "Q-01..Q-15"
    assert summary["banned_words_found"] == 0
    # Overlap flags reported (Q-01 and Q-15 have >=4 words run)
    assert summary["flagged_runs_count"] == 2


def test_validate_queries_catches_bad_count(real_queries_data, tmp_path):
    """Fails if count is not 15."""
    bad_data = real_queries_data[:14]
    p = tmp_path / "bad_count.json"
    p.write_text(json.dumps(bad_data), encoding="utf-8")

    with pytest.raises(ValueError, match="Expected exactly 15 queries"):
        validate_queries(str(p), kb_path=REAL_KB_PATH)


def test_validate_queries_catches_bad_id_sequence(real_queries_data, tmp_path):
    """Fails if query_ids are not Q-01..Q-15 in order."""
    bad_data = copy.deepcopy(real_queries_data)
    bad_data[0]["query_id"] = "Q-99"
    p = tmp_path / "bad_id.json"
    p.write_text(json.dumps(bad_data), encoding="utf-8")

    with pytest.raises(ValueError, match="query_ids do not match Q-01..Q-15"):
        validate_queries(str(p), kb_path=REAL_KB_PATH)


def test_validate_queries_catches_missing_kb_id(real_queries_data, tmp_path):
    """Fails if expected_kb_id does not exist in the KB."""
    bad_data = copy.deepcopy(real_queries_data)
    bad_data[0]["expected_kb_id"] = "KB-999"
    p = tmp_path / "bad_kb_id.json"
    p.write_text(json.dumps(bad_data), encoding="utf-8")

    with pytest.raises(ValueError, match="not found in KB"):
        validate_queries(str(p), kb_path=REAL_KB_PATH)


def test_validate_queries_catches_empty_query(real_queries_data, tmp_path):
    """Fails if query text is empty."""
    bad_data = copy.deepcopy(real_queries_data)
    bad_data[2]["query"] = "   "
    p = tmp_path / "empty_query.json"
    p.write_text(json.dumps(bad_data), encoding="utf-8")

    with pytest.raises(ValueError, match="empty or whitespace only"):
        validate_queries(str(p), kb_path=REAL_KB_PATH)


def test_validate_queries_catches_banned_words(real_queries_data, tmp_path):
    """Fails if query contains banned words."""
    bad_data = copy.deepcopy(real_queries_data)
    bad_data[4]["query"] += " This is a critical urgent blocker."
    p = tmp_path / "banned.json"
    p.write_text(json.dumps(bad_data), encoding="utf-8")

    with pytest.raises(ValueError, match="Banned words violations"):
        validate_queries(str(p), kb_path=REAL_KB_PATH)
