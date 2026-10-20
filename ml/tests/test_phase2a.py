"""Tests for Phase 2a: data validation, splitting, and ML FastAPI endpoints."""

import os
import pytest
import pandas as pd
from fastapi.testclient import TestClient

from ml.tools.validate_data import validate_tickets, validate_gold_set, find_banned_words
from ml.tools.make_splits import make_splits
from ml.app import app, load_resources


# ==========================================
# 1. Tests for validate_data
# ==========================================

def test_find_banned_words():
    assert find_banned_words("This is a severe outage") == ["severe"]
    assert find_banned_words("High priority ticket opened") == ["high priority"]
    assert find_banned_words("System is operational and healthy") == []
    assert find_banned_words("This is sev1 blocker") == ["sev1", "blocker"]


def test_validate_tickets_valid():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    tickets_path = os.path.join(root, "ml", "data", "tickets_v3.csv")
    df = pd.read_csv(tickets_path)
    validate_tickets(df)


def test_validate_tickets_bad_row_count():
    df = pd.DataFrame([{"title": "t", "description": "d", "label": "P1"}] * 10)
    with pytest.raises(ValueError, match="expected exactly 300 rows"):
        validate_tickets(df)


def test_validate_tickets_bad_label():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    tickets_path = os.path.join(root, "ml", "data", "tickets_v3.csv")
    df = pd.read_csv(tickets_path).copy()
    df.loc[0, "label"] = "P5"
    with pytest.raises(ValueError, match="invalid labels found"):
        validate_tickets(df)


def test_validate_tickets_banned_word():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    tickets_path = os.path.join(root, "ml", "data", "tickets_v3.csv")
    df = pd.read_csv(tickets_path).copy()
    df.loc[0, "description"] = "This is a critical showstopper that breaks auth"
    with pytest.raises(ValueError, match="banned word violations"):
        validate_tickets(df)


def test_validate_gold_set_valid():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    gold_path = os.path.join(root, "ml", "data", "gold_set.csv")
    df = pd.read_csv(gold_path)
    raw_agree, kappa = validate_gold_set(df)
    assert 0.0 <= raw_agree <= 1.0
    assert -1.0 <= kappa <= 1.0


def test_validate_gold_set_insufficient_p1():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    gold_path = os.path.join(root, "ml", "data", "gold_set.csv")
    df = pd.read_csv(gold_path).copy()
    # Replace all P1s with P3
    df["final_label"] = df["final_label"].replace({"P1": "P3"})
    with pytest.raises(ValueError, match="expected at least 3 P1 rows"):
        validate_gold_set(df)


# ==========================================
# 2. Tests for make_splits
# ==========================================

def test_make_splits_separation(tmp_path):
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    tickets_path = os.path.join(root, "ml", "data", "tickets_v3.csv")
    gold_path = os.path.join(root, "ml", "data", "gold_set.csv")
    out_dir = str(tmp_path / "splits")

    train_df, val_df, t2_df, t3_df = make_splits(
        tickets_path=tickets_path,
        gold_path=gold_path,
        output_dir=out_dir,
        seed=42,
    )

    # Check row counts
    assert len(train_df) == 160
    assert len(val_df) == 40
    assert len(t2_df) == 100
    assert len(t3_df) == 15

    # T2 contains only gemini
    assert set(t2_df["generator"].unique()) == {"gemini"}

    # Train and Val contain only chatgpt and claude
    assert set(train_df["generator"].unique()).issubset({"chatgpt", "claude"})
    assert set(val_df["generator"].unique()).issubset({"chatgpt", "claude"})

    # Check strictly no overlap between train, val, and t2
    def get_ticket_keys(df):
        return set(df["generator"] + "___" + df["spec_id"].astype(str) + "___" + df["title"])

    train_keys = get_ticket_keys(train_df)
    val_keys = get_ticket_keys(val_df)
    t2_keys = get_ticket_keys(t2_df)

    assert len(train_keys.intersection(val_keys)) == 0, "Overlap found between train and val"
    assert len(train_keys.intersection(t2_keys)) == 0, "Overlap found between train and T2"
    assert len(val_keys.intersection(t2_keys)) == 0, "Overlap found between val and T2"


# ==========================================
# 3. Tests for ML App endpoints
# ==========================================

@pytest.fixture
def client():
    load_resources()
    with TestClient(app) as test_client:
        yield test_client


def test_health_endpoint(client):
    res = client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert data["model_loaded"] is True
    assert data["model_name"] == "sentence_transformer_logreg"
    assert data["validation_macro_f1"] is not None
    assert data["validation_macro_f1"] > 0.0


def test_classify_endpoint_sample_ticket(client):
    payload = {
        "title": "Database connection pool exhausted",
        "description": "Users cannot log in to the portal due to connection timeout and all worker threads blocked",
    }
    res = client.post("/classify", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["predicted_label"] in ["P1", "P2", "P3", "P4"]
    assert "probabilities" in data
    assert set(data["probabilities"].keys()) == {"P1", "P2", "P3", "P4"}
    prob_sum = sum(data["probabilities"].values())
    assert abs(prob_sum - 1.0) < 0.01


def test_classify_endpoint_503_when_no_model(client):
    saved_model = app.state.model
    try:
        app.state.model = None
        res = client.post("/classify", json={"title": "Test", "description": "Test description"})
        assert res.status_code == 503
        assert "not loaded" in res.json()["detail"]
    finally:
        app.state.model = saved_model


def test_embed_endpoint(client):
    res = client.post("/embed", json={"text": "Test embedding generation"})
    assert res.status_code == 200
    data = res.json()
    assert data["dimensions"] == 384
    assert len(data["embedding"]) == 384


def test_embed_endpoint_503_when_no_provider(client):
    saved_emb = app.state.embedding_model
    try:
        app.state.embedding_model = None
        res = client.post("/embed", json={"text": "Hello"})
        assert res.status_code == 503
        assert "unavailable" in res.json()["detail"]
    finally:
        app.state.embedding_model = saved_emb
