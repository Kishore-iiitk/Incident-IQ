"""Knowledge Base (KB) validation tool.

Validates:
- Exactly 30 objects.
- IDs KB-001..KB-030 in order.
- Required fields: id, family, service, title, symptoms, root_cause, resolution, prevention all non-empty strings.
- 6 families (login_failure, upload_failure, slow_or_timeout, grades_issue, notification_failure, video_playback) with exactly 5 each.
- No banned words (critical, urgent, severe, severity, sev1, sev2, p1, p2, p3, p4, priority, emergency, blocker, showstopper).
- Within each family, the 5 root_cause texts must be genuinely different (TF-IDF cosine <= 0.6 for all pairs).
"""

import json
import os
import re
import sys
from collections import Counter
from typing import Dict, List, Tuple, Any

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

EXPECTED_COUNT = 30
EXPECTED_FAMILIES = {
    "login_failure": 5,
    "upload_failure": 5,
    "slow_or_timeout": 5,
    "grades_issue": 5,
    "notification_failure": 5,
    "video_playback": 5,
}

REQUIRED_FIELDS = [
    "id",
    "family",
    "service",
    "title",
    "symptoms",
    "root_cause",
    "resolution",
    "prevention",
]

BANNED_WORDS = [
    "critical",
    "urgent",
    "severe",
    "severity",
    "sev1",
    "sev2",
    "p1",
    "p2",
    "p3",
    "p4",
    "priority",
    "emergency",
    "blocker",
    "showstopper",
]

_escaped = [re.escape(w).replace(r"\ ", r"\s+") for w in sorted(BANNED_WORDS, key=len, reverse=True)]
BANNED_REGEX = re.compile(r"\b(" + "|".join(_escaped) + r")\b", re.IGNORECASE)


def find_banned_words(text: str) -> List[str]:
    """Return all occurrences of banned words in text (lowercased)."""
    if not isinstance(text, str):
        return []
    return [m.lower() for m in BANNED_REGEX.findall(text)]


def validate_kb(filepath: str) -> Dict[str, Any]:
    """Validate a knowledge base JSON file.

    Raises ValueError if validation fails.
    Returns a dictionary summarizing validation results.
    """
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"KB file not found: {filepath}")

    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, list):
        raise ValueError(f"KB root must be a JSON array, got {type(data).__name__}")

    errors: List[str] = []

    # 1. Exactly 30 objects
    if len(data) != EXPECTED_COUNT:
        errors.append(f"Expected exactly {EXPECTED_COUNT} objects, found {len(data)}")

    # 2. IDs KB-001..KB-030 in order
    expected_ids = [f"KB-{i:03d}" for i in range(1, EXPECTED_COUNT + 1)]
    actual_ids = [item.get("id") if isinstance(item, dict) else None for item in data]
    if actual_ids != expected_ids:
        id_mismatches = [
            f"index {idx}: expected {exp}, got {act}"
            for idx, (exp, act) in enumerate(zip(expected_ids, actual_ids))
            if exp != act
        ]
        if len(actual_ids) > len(expected_ids):
            id_mismatches.append(f"extra items beyond {EXPECTED_COUNT}: {actual_ids[EXPECTED_COUNT:]}")
        elif len(actual_ids) < len(expected_ids):
            id_mismatches.append(f"missing items from index {len(actual_ids)}")
        errors.append(f"IDs do not match KB-001..KB-{EXPECTED_COUNT:03d} in order:\n  " + "\n  ".join(id_mismatches[:5]))

    # 3. Required fields and non-empty strings
    missing_field_errors = []
    banned_violations = []

    for idx, item in enumerate(data):
        if not isinstance(item, dict):
            errors.append(f"Item at index {idx} is not an object: {type(item).__name__}")
            continue

        item_id = item.get("id", f"index-{idx}")

        for field in REQUIRED_FIELDS:
            val = item.get(field)
            if val is None:
                missing_field_errors.append(f"{item_id}: missing required field '{field}'")
            elif not isinstance(val, str):
                missing_field_errors.append(f"{item_id}: field '{field}' must be a string, got {type(val).__name__}")
            elif not val.strip():
                missing_field_errors.append(f"{item_id}: field '{field}' is empty or whitespace only")

        # 5. Check banned words in all string fields
        for key, val in item.items():
            if isinstance(val, str):
                matches = find_banned_words(val)
                if matches:
                    banned_violations.append(f"{item_id} (field '{key}'): banned word(s) {matches}")

    if missing_field_errors:
        errors.append(f"Required field violations ({len(missing_field_errors)}):\n  " + "\n  ".join(missing_field_errors[:5]))

    # 4. 6 families with exactly 5 each
    family_counts = Counter(item.get("family") for item in data if isinstance(item, dict))
    family_errors = []
    for fam, expected_freq in EXPECTED_FAMILIES.items():
        actual_freq = family_counts.get(fam, 0)
        if actual_freq != expected_freq:
            family_errors.append(f"Family '{fam}': expected {expected_freq}, got {actual_freq}")

    unexpected_families = set(family_counts.keys()) - set(EXPECTED_FAMILIES.keys())
    if unexpected_families:
        family_errors.append(f"Unexpected families found: {unexpected_families}")

    if family_errors:
        errors.append("Family distribution violations:\n  " + "\n  ".join(family_errors))

    # Banned words error reporting
    if banned_violations:
        errors.append(f"Banned words detected ({len(banned_violations)}):\n  " + "\n  ".join(banned_violations[:5]))

    # 6. Within each family, the 5 root_cause texts must have TF-IDF cosine <= 0.6
    tfidf_violations = []
    family_max_sims = {}

    for fam in EXPECTED_FAMILIES:
        family_items = [item for item in data if isinstance(item, dict) and item.get("family") == fam]
        if len(family_items) < 2:
            continue

        rc_texts = [item.get("root_cause", "") for item in family_items]
        if any(t.strip() for t in rc_texts):
            vec = TfidfVectorizer()
            mat = vec.fit_transform(rc_texts)
            sim = cosine_similarity(mat)
            max_sim = 0.0

            for i in range(len(family_items)):
                for j in range(i + 1, len(family_items)):
                    score = float(sim[i, j])
                    if score > max_sim:
                        max_sim = score
                    if score > 0.6:
                        id_i = family_items[i].get("id", f"idx-{i}")
                        id_j = family_items[j].get("id", f"idx-{j}")
                        tfidf_violations.append(
                            f"Family '{fam}': {id_i} and {id_j} have TF-IDF cosine similarity {score:.4f} > 0.6"
                        )
            family_max_sims[fam] = max_sim

    if tfidf_violations:
        errors.append("TF-IDF root cause distinctness violations:\n  " + "\n  ".join(tfidf_violations))

    if errors:
        error_msg = f"KB validation failed with {len(errors)} error category(ies):\n\n" + "\n\n".join(errors)
        raise ValueError(error_msg)

    return {
        "filepath": filepath,
        "total_objects": len(data),
        "ids_range": f"{actual_ids[0]}..{actual_ids[-1]}",
        "families": dict(family_counts),
        "banned_words_found": len(banned_violations),
        "family_max_similarities": family_max_sims,
    }


def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    default_path = os.path.join(root, "ml", "data", "chat_outputs", "kb", "kb_batch_01.json")

    filepath = sys.argv[1] if len(sys.argv) > 1 else default_path
    print(f"==================================================")
    print(f"Incident-IQ Knowledge Base Validator")
    print(f"Target: {filepath}")
    print(f"==================================================")

    try:
        report = validate_kb(filepath)
        print(f"[OK] Total Incidents: {report['total_objects']}")
        print(f"[OK] ID Range: {report['ids_range']} (consecutive)")
        print(f"[OK] Required fields non-empty across all items")
        print(f"[OK] Families: {report['families']}")
        print(f"[OK] Banned words: 0 detected")
        print(f"[OK] TF-IDF root cause max similarities per family:")
        for fam, sim in report["family_max_similarities"].items():
            print(f"     - {fam:20s}: max cosine = {sim:.4f} (<= 0.6)")
        print("\nAll KB validation checks PASSED successfully.")
        sys.exit(0)
    except Exception as exc:
        print(f"\n[FAIL] KB VALIDATION FAILED:\n{exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
