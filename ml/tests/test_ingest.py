import csv
import json
import os
import pytest
from ml.tools.ingest_tickets import find_banned_words, ingest_tickets


def test_find_banned_words():
    # Single banned words
    assert find_banned_words("This is a critical bug") == ["critical"]
    assert find_banned_words("We have a Sev1 incident") == ["sev1"]
    assert find_banned_words("Ticket is marked P1") == ["p1"]
    assert find_banned_words("System is in emergency mode") == ["emergency"]
    assert find_banned_words("Showstopper defect on checkout") == ["showstopper"]
    assert find_banned_words("Major blocker for release") == ["blocker"]

    # Multi-word banned phrases
    assert find_banned_words("Please treat this as high priority") == ["high priority"]
    assert find_banned_words("Set this to low priority") == ["low priority"]

    # Non-banned words containing substrings should NOT match
    assert find_banned_words("Connecting to HTTP1 endpoint on node1") == []
    assert find_banned_words("The application resumed operation normally") == []


def test_ingest_tickets_with_fixtures(tmp_path):
    # Setup test directories
    specs_dir = tmp_path / "specs"
    specs_dir.mkdir()
    chat_dir = tmp_path / "chat_outputs" / "test_bot"
    chat_dir.mkdir(parents=True)
    catalog_path = tmp_path / "service_catalog.json"
    output_csv = tmp_path / "tickets_v3.csv"
    report_path = tmp_path / "ingest_report.md"

    # 1. Create a minimal service catalog
    catalog = [
        {"name": "auth-sso", "tier": 1, "category": "Auth", "owning_team": "Auth"},
        {"name": "grade-service", "tier": 2, "category": "Backend", "owning_team": "Backend"}
    ]
    with open(catalog_path, "w", encoding="utf-8") as f:
        json.dump(catalog, f)

    # 2. Create minimal specs
    specs = [
        {
            "spec_id": "SPEC-0001",
            "service": "auth-sso",
            "domain_hint": "Single Sign-On authentication",
            "tier": 1,
            "scope": "all",
            "data_loss": True,
            "workaround": "none",
            "style": "monitoring_alert",
            "length": "short",
            "vague": False
        },
        {
            "spec_id": "SPEC-0002",
            "service": "grade-service",
            "domain_hint": "Grade calculation",
            "tier": 2,
            "scope": "single",
            "data_loss": False,
            "workaround": "easy",
            "style": "user_email",
            "length": "short",
            "vague": False
        }
    ]
    with open(specs_dir / "ticket_batch_01.json", "w", encoding="utf-8") as f:
        json.dump(specs, f)

    # 3. Create chatbot output fixture with:
    # - 1 valid ticket for SPEC-0001 (P1 facts)
    # - 1 missing field ticket
    # - 1 unknown spec_id ticket
    # - 1 banned word ticket ("urgent")
    # - 1 short description ticket (< 8 words)
    # - 1 duplicate ticket of the valid ticket
    chat_batch = [
        {
            "spec_id": "SPEC-0001",
            "title": "SAML gateway timeout error 504",
            "description": "Users across all campus departments cannot authenticate to any course portal services this morning."
        },
        {
            # Missing description
            "spec_id": "SPEC-0002",
            "title": "Gradebook sync error",
            "description": ""
        },
        {
            # Unknown spec ID
            "spec_id": "SPEC-9999",
            "title": "Unknown issue on cluster",
            "description": "There is an unknown system reporting errors in the staging environment cluster."
        },
        {
            # Banned word: "urgent"
            "spec_id": "SPEC-0002",
            "title": "Urgent grade calculation error",
            "description": "Please look at this grade calculation error immediately for student section 4."
        },
        {
            # Too short (< 8 words)
            "spec_id": "SPEC-0002",
            "title": "Gradebook broken",
            "description": "Gradebook is failing for one user."
        },
        {
            # Near duplicate of first valid ticket
            "spec_id": "SPEC-0001",
            "title": "SAML gateway timeout error 504",
            "description": "Users across all campus departments cannot authenticate to any course portal services this morning."
        }
    ]
    with open(chat_dir / "ticket_batch_01.json", "w", encoding="utf-8") as f:
        json.dump(chat_batch, f)

    # Run ingestion
    result = ingest_tickets(
        chat_outputs_dir=str(tmp_path / "chat_outputs"),
        specs_dir=str(specs_dir),
        catalog_path=str(catalog_path),
        output_csv=str(output_csv),
        report_path=str(report_path)
    )

    assert result["total"] == 6
    assert result["accepted"] == 1
    assert result["rejected"] == 5

    # Check rejection reasons
    reasons = [r["reason"] for r in result["rejected_records"]]
    assert any("Missing or empty required field" in r for r in reasons)
    assert any("Unknown spec_id" in r for r in reasons)
    assert any("Contains banned word(s): urgent" in r for r in reasons)
    assert any("Description too short" in r for r in reasons)
    assert any("Near-duplicate" in r for r in reasons)

    # Check generated CSV
    assert os.path.exists(output_csv)
    with open(output_csv, "r", encoding="utf-8") as f:
        reader = list(csv.DictReader(f))
        assert len(reader) == 1
        row = reader[0]
        assert row["spec_id"] == "SPEC-0001"
        assert row["generator"] == "test_bot"
        assert row["service"] == "auth-sso"
        assert row["category"] == "Auth"
        assert row["tier"] == "1"
        assert row["scope"] == "all"
        assert row["data_loss"] == "True"
        assert row["workaround"] == "none"
        assert row["label"] == "P1"  # Derived via rubric!

    # Check generated report markdown
    assert os.path.exists(report_path)
    with open(report_path, "r", encoding="utf-8") as f:
        report_content = f.read()
        assert "Total candidates evaluated**: 6" in report_content
        assert "Accepted tickets written to CSV**: 1" in report_content
        assert "SPEC-9999" in report_content
