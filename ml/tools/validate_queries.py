"""Retrieval Query validation tool.

Validates:
- Exactly 15 items.
- query_ids Q-01..Q-15 in order.
- expected_kb_id exists in the KB.
- Each query non-empty string.
- No banned words (critical, urgent, severe, severity, sev1, sev2, p1, p2, p3, p4, priority, emergency, blocker, showstopper).
- For each query, reports the longest run of consecutive words shared with the expected incident's title + symptoms.
- Flags any run of 4 or more words.
"""

import argparse
import json
import os
import re
import sys
from typing import Any, Dict, List, Tuple

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

EXPECTED_COUNT = 15
EXPECTED_QUERY_IDS = [f"Q-{i:02d}" for i in range(1, EXPECTED_COUNT + 1)]

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


def tokenize_words(text: str) -> List[str]:
    """Extract lowercased alphanumeric words."""
    return re.findall(r"\b[a-zA-Z0-9_\-]+\b", text.lower())


def longest_common_consecutive_run(tokens_a: List[str], tokens_b: List[str]) -> Tuple[int, List[str]]:
    """Find the longest common contiguous slice of tokens between two token lists."""
    len_a, len_b = len(tokens_a), len(tokens_b)
    if len_a == 0 or len_b == 0:
        return 0, []

    max_len = 0
    end_idx_a = 0
    dp = [[0] * (len_b + 1) for _ in range(len_a + 1)]

    for i in range(1, len_a + 1):
        for j in range(1, len_b + 1):
            if tokens_a[i - 1] == tokens_b[j - 1]:
                dp[i][j] = dp[i - 1][j - 1] + 1
                if dp[i][j] > max_len:
                    max_len = dp[i][j]
                    end_idx_a = i
            else:
                dp[i][j] = 0

    best_phrase = tokens_a[end_idx_a - max_len : end_idx_a]
    return max_len, best_phrase


def validate_queries(queries_path: str, kb_path: str = None) -> Dict[str, Any]:
    """Validate retrieval queries JSON file against requirements and KB entries.

    Raises ValueError if structural or content constraints fail (count, IDs, banned words, missing KB ID).
    Returns validation summary including overlap analysis and flags.
    """
    if not os.path.exists(queries_path):
        raise FileNotFoundError(f"Queries file not found: {queries_path}")

    with open(queries_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, list):
        raise ValueError(f"Queries root must be a JSON array, got {type(data).__name__}")

    # Load Knowledge Base
    if kb_path is None:
        kb_path = os.path.join(ROOT_DIR, "ml", "data", "chat_outputs", "kb", "kb_batch_01.json")
    if not os.path.exists(kb_path):
        # Fallback to server index if raw kb file path is different
        kb_path = os.path.join(ROOT_DIR, "server", "rag", "kb_index.json")

    with open(kb_path, "r", encoding="utf-8") as f:
        raw_kb = json.load(f)
        kb_items = raw_kb if isinstance(raw_kb, list) else raw_kb.get("incidents", [])

    kb_map = {item["id"]: item for item in kb_items if isinstance(item, dict) and "id" in item}

    errors: List[str] = []

    # 1. Exactly 15 items
    if len(data) != EXPECTED_COUNT:
        errors.append(f"Expected exactly {EXPECTED_COUNT} queries, got {len(data)}")

    # 2. query_ids Q-01..Q-15 in order
    actual_ids = [item.get("query_id") if isinstance(item, dict) else None for item in data]
    if actual_ids != EXPECTED_QUERY_IDS:
        id_mismatches = [
            f"index {idx}: expected {exp}, got {act}"
            for idx, (exp, act) in enumerate(zip(EXPECTED_QUERY_IDS, actual_ids))
            if exp != act
        ]
        if len(actual_ids) > len(EXPECTED_QUERY_IDS):
            id_mismatches.append(f"extra items beyond {EXPECTED_COUNT}: {actual_ids[EXPECTED_COUNT:]}")
        elif len(actual_ids) < len(EXPECTED_QUERY_IDS):
            id_mismatches.append(f"missing items from index {len(actual_ids)}")
        errors.append(f"query_ids do not match Q-01..Q-{EXPECTED_COUNT:02d} in order:\n  " + "\n  ".join(id_mismatches[:5]))

    # 3. Required fields, empty query check, banned words, and expected_kb_id existence
    missing_fields = []
    empty_queries = []
    missing_kb_ids = []
    banned_violations = []
    overlaps: List[Dict[str, Any]] = []
    flagged_runs: List[Dict[str, Any]] = []

    for idx, item in enumerate(data):
        if not isinstance(item, dict):
            errors.append(f"Item at index {idx} is not an object: {type(item).__name__}")
            continue

        qid = item.get("query_id", f"index-{idx}")
        expected_kb_id = item.get("expected_kb_id")
        query_text = item.get("query")

        if not expected_kb_id:
            missing_fields.append(f"{qid}: missing 'expected_kb_id'")
        elif expected_kb_id not in kb_map:
            missing_kb_ids.append(f"{qid}: expected_kb_id '{expected_kb_id}' not found in KB")

        if query_text is None:
            missing_fields.append(f"{qid}: missing 'query'")
        elif not isinstance(query_text, str) or not query_text.strip():
            empty_queries.append(f"{qid}: 'query' is empty or whitespace only")

        # Banned words check across all fields
        for k, v in item.items():
            if isinstance(v, str):
                banned_found = find_banned_words(v)
                if banned_found:
                    banned_violations.append(f"{qid} (field '{k}'): banned words {banned_found}")

        # Overlap computation with expected incident's title + symptoms
        if expected_kb_id in kb_map and isinstance(query_text, str):
            target_incident = kb_map[expected_kb_id]
            target_text = f"{target_incident.get('title', '')} {target_incident.get('symptoms', '')}"
            q_tokens = tokenize_words(query_text)
            t_tokens = tokenize_words(target_text)

            run_len, phrase = longest_common_consecutive_run(q_tokens, t_tokens)
            overlap_info = {
                "query_id": qid,
                "expected_kb_id": expected_kb_id,
                "incident_title": target_incident.get("title", ""),
                "max_run_length": run_len,
                "shared_phrase": " ".join(phrase),
                "is_flagged": run_len >= 4,
            }
            overlaps.append(overlap_info)
            if run_len >= 4:
                flagged_runs.append(overlap_info)

    if missing_fields:
        errors.append(f"Missing fields ({len(missing_fields)}):\n  " + "\n  ".join(missing_fields[:5]))
    if empty_queries:
        errors.append(f"Empty queries ({len(empty_queries)}):\n  " + "\n  ".join(empty_queries[:5]))
    if missing_kb_ids:
        errors.append(f"Missing KB IDs ({len(missing_kb_ids)}):\n  " + "\n  ".join(missing_kb_ids[:5]))
    if banned_violations:
        errors.append(f"Banned words violations ({len(banned_violations)}):\n  " + "\n  ".join(banned_violations[:5]))

    if errors:
        raise ValueError(f"Queries validation failed with {len(errors)} error(s):\n\n" + "\n\n".join(errors))

    return {
        "queries_path": queries_path,
        "kb_path": kb_path,
        "total_queries": len(data),
        "query_ids_range": f"{actual_ids[0]}..{actual_ids[-1]}",
        "banned_words_found": len(banned_violations),
        "overlaps": overlaps,
        "flagged_runs_count": len(flagged_runs),
        "flagged_runs": flagged_runs,
    }


def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    default_queries = os.path.join(root, "ml", "data", "retrieval_queries.json")
    default_kb = os.path.join(root, "ml", "data", "chat_outputs", "kb", "kb_batch_01.json")

    parser = argparse.ArgumentParser(description="Validate retrieval queries dataset")
    parser.add_argument("queries_path", nargs="?", default=default_queries, help="Path to retrieval_queries.json")
    parser.add_argument("--kb-path", default=default_kb, help="Path to KB JSON file")

    args = parser.parse_args()

    print("==================================================")
    print("Incident-IQ Retrieval Queries Validator")
    print(f"Target: {args.queries_path}")
    print("==================================================")

    try:
        report = validate_queries(args.queries_path, kb_path=args.kb_path)
        print(f"[OK] Total Queries: {report['total_queries']} (exactly 15)")
        print(f"[OK] Query IDs: {report['query_ids_range']} (consecutive)")
        print(f"[OK] All expected_kb_ids exist in KB")
        print(f"[OK] All queries are non-empty strings")
        print(f"[OK] Banned words: 0 detected")
        print("\n--- Consecutive Word Run Analysis (vs target title+symptoms) ---")
        for item in report["overlaps"]:
            flag_str = " --> FLAGGED (>= 4 words)" if item["is_flagged"] else ""
            print(
                f"  {item['query_id']} -> {item['expected_kb_id']}: max run = {item['max_run_length']} "
                f"('{item['shared_phrase']}'){flag_str}"
            )

        if report["flagged_runs_count"] > 0:
            print(f"\n[NOTE] {report['flagged_runs_count']} query(ies) flagged with run of 4+ consecutive words:")
            for fl in report["flagged_runs"]:
                print(f"  - {fl['query_id']} -> {fl['expected_kb_id']}: run={fl['max_run_length']} words: '{fl['shared_phrase']}'")
            print("  Refer to ml/results/retrieval_query_review.md for human review.")
        else:
            print("\n[OK] No queries have runs of 4 or more consecutive words.")

        print("\nValidation completed successfully.")
        sys.exit(0)
    except Exception as exc:
        print(f"\n[FAIL] QUERIES VALIDATION FAILED:\n{exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
