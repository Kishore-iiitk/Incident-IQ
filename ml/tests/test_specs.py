import json
import glob
import pytest
from ml.tools.make_specs import validate_spec, load_services


def test_validate_spec_rejects_banned_words():
    catalog_lookup = {
        "auth-sso": {"name": "auth-sso", "tier": 1, "holds_user_data": False},
        "payments": {"name": "payments", "tier": 1, "holds_user_data": True}
    }

    # Banned word in domain_hint
    spec_with_banned = {
        "spec_id": "TEST-0001",
        "service": "payments",
        "domain_hint": "This is an emergency payment issue",
        "tier": 1,
        "scope": "all",
        "data_loss": False,
        "workaround": "none",
        "style": "monitoring_alert",
        "length": "short",
        "vague": False
    }

    with pytest.raises(ValueError, match="contains banned word.*emergency"):
        validate_spec(spec_with_banned, catalog_lookup)

    # Multi-word banned phrase
    spec_with_phrase = {
        "spec_id": "TEST-0002",
        "service": "payments",
        "domain_hint": "Treat this as high priority incident",
        "tier": 1,
        "scope": "all",
        "data_loss": False,
        "workaround": "none",
        "style": "monitoring_alert",
        "length": "short",
        "vague": False
    }
    with pytest.raises(ValueError, match="contains banned word.*high priority"):
        validate_spec(spec_with_phrase, catalog_lookup)


def test_validate_spec_rejects_incoherent_data_loss():
    catalog_lookup = {
        "auth-sso": {"name": "auth-sso", "tier": 1, "holds_user_data": False},
        "payments": {"name": "payments", "tier": 1, "holds_user_data": True}
    }

    # data_loss = True on service where holds_user_data = False
    incoherent_spec = {
        "spec_id": "TEST-0003",
        "service": "auth-sso",
        "domain_hint": "Single Sign-On authentication and SAML assertions",
        "tier": 1,
        "scope": "all",
        "data_loss": True,
        "workaround": "none",
        "style": "monitoring_alert",
        "length": "short",
        "vague": False
    }

    with pytest.raises(ValueError, match="does not hold user data"):
        validate_spec(incoherent_spec, catalog_lookup)


def test_validate_spec_accepts_valid_spec():
    catalog_lookup = {
        "payments": {"name": "payments", "tier": 1, "holds_user_data": True}
    }

    valid_spec = {
        "spec_id": "TEST-0004",
        "service": "payments",
        "domain_hint": "Tuition fee checkout and transaction gateway",
        "tier": 1,
        "scope": "all",
        "data_loss": True,
        "workaround": "none",
        "style": "monitoring_alert",
        "length": "short",
        "vague": False
    }

    # Should not raise
    validate_spec(valid_spec, catalog_lookup)


def test_all_generated_specs_pass_validation():
    _, catalog_lookup = load_services("ml/data/service_catalog.json")
    spec_files = glob.glob("ml/data/specs/ticket_batch_*.json")
    assert len(spec_files) == 16, f"Expected 16 spec batch files, found {len(spec_files)}"

    total_specs = 0
    for fpath in spec_files:
        with open(fpath, "r", encoding="utf-8") as f:
            batch = json.load(f)
            assert len(batch) == 50, f"File {fpath} should contain 50 specs"
            for spec in batch:
                validate_spec(spec, catalog_lookup)
                total_specs += 1

    assert total_specs == 800


def test_label_distribution_and_stratification():
    from collections import Counter
    from ml.rubric import label_from_facts

    spec_files = sorted(glob.glob("ml/data/specs/ticket_batch_*.json"))
    assert len(spec_files) == 16

    overall_labels = Counter()
    service_counts = Counter()
    vague_count = 0

    for idx, fpath in enumerate(spec_files, start=1):
        with open(fpath, "r", encoding="utf-8") as f:
            batch = json.load(f)
            batch_labels = Counter()
            for s in batch:
                lbl = label_from_facts(s["tier"], s["scope"], s["data_loss"], s["workaround"])
                batch_labels[lbl] += 1
                overall_labels[lbl] += 1
                service_counts[s["service"]] += 1
                if s["vague"]:
                    vague_count += 1

            # Every batch must be strictly stratified
            assert batch_labels["P1"] == 6, f"Batch {idx} should have 6 P1"
            assert batch_labels["P2"] == 12, f"Batch {idx} should have 12 P2"
            assert batch_labels["P3"] == 21, f"Batch {idx} should have 21 P3"
            assert batch_labels["P4"] == 11, f"Batch {idx} should have 11 P4"

    # Overall totals
    assert overall_labels["P1"] == 96  # 12%
    assert overall_labels["P2"] == 192  # 24%
    assert overall_labels["P3"] == 336  # 42%
    assert overall_labels["P4"] == 176  # 22%

    # Exactly 20 specs per service across all 40 services
    assert len(service_counts) == 40
    assert min(service_counts.values()) == 20
    assert max(service_counts.values()) == 20

    # Exactly 15% vague
    assert vague_count == 120

