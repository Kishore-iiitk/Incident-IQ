"""Validation script for tickets_v3.csv and gold_set.csv.

Checks:
- tickets_v3.csv:
    * exactly 300 rows
    * labels strictly in {'P1', 'P2', 'P3', 'P4'}
    * no banned words in title or description
- gold_set.csv:
    * columns: id, title, description, label_a, label_b, final_label
    * exactly 15 rows
    * final_label in {'P1', 'P2', 'P3', 'P4'}
    * at least 3 P1 rows in final_label
    * no banned words in title or description
- computes and prints raw agreement and Cohen's kappa between label_a and label_b
- fails loudly on any problem
"""

import os
import re
import sys
import pandas as pd
from sklearn.metrics import cohen_kappa_score

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
    "high priority",
    "low priority",
    "blocker",
    "showstopper",
]

# Order longest first so "high priority" matches before "priority"
_escaped = [re.escape(w).replace(r"\ ", r"\s+") for w in sorted(BANNED_WORDS, key=len, reverse=True)]
BANNED_REGEX = re.compile(r"\b(" + "|".join(_escaped) + r")\b", re.IGNORECASE)

VALID_LABELS = {"P1", "P2", "P3", "P4"}


def find_banned_words(text: str):
    """Return all occurrences of banned words in text (lowercased)."""
    if not isinstance(text, str):
        return []
    return [m.lower() for m in BANNED_REGEX.findall(text)]


def validate_tickets(df: pd.DataFrame, filepath: str = "tickets_v3.csv"):
    """Validate tickets_v3 dataframe. Raises ValueError on violation."""
    if len(df) != 300:
        raise ValueError(f"{filepath}: expected exactly 300 rows, got {len(df)}")

    if "label" not in df.columns:
        raise ValueError(f"{filepath}: missing required column 'label'")

    invalid_labels = set(df["label"]) - VALID_LABELS
    if invalid_labels:
        raise ValueError(f"{filepath}: invalid labels found: {invalid_labels}")

    for col in ["title", "description"]:
        if col not in df.columns:
            raise ValueError(f"{filepath}: missing required column '{col}'")

    banned_violations = []
    for idx, row in df.iterrows():
        title_banned = find_banned_words(row.get("title", ""))
        desc_banned = find_banned_words(row.get("description", ""))
        if title_banned or desc_banned:
            banned_violations.append(
                f"Row {idx} (spec_id={row.get('spec_id')}): title matches={title_banned}, desc matches={desc_banned}"
            )

    if banned_violations:
        sample = "\n".join(banned_violations[:5])
        raise ValueError(
            f"{filepath}: found {len(banned_violations)} banned word violations:\n{sample}"
        )


def validate_gold_set(df: pd.DataFrame, filepath: str = "gold_set.csv"):
    """Validate gold_set dataframe. Raises ValueError on violation.
    Returns (raw_agreement, kappa).
    """
    expected_cols = ["id", "title", "description", "label_a", "label_b", "final_label"]
    missing_cols = [c for c in expected_cols if c not in df.columns]
    if missing_cols:
        raise ValueError(f"{filepath}: missing required columns: {missing_cols}")

    if len(df) != 15:
        raise ValueError(f"{filepath}: expected exactly 15 rows, got {len(df)}")

    invalid_final = set(df["final_label"]) - VALID_LABELS
    if invalid_final:
        raise ValueError(f"{filepath}: invalid final_label values: {invalid_final}")

    p1_count = (df["final_label"] == "P1").sum()
    if p1_count < 3:
        raise ValueError(f"{filepath}: expected at least 3 P1 rows in final_label, got {p1_count}")

    banned_violations = []
    for idx, row in df.iterrows():
        title_banned = find_banned_words(row.get("title", ""))
        desc_banned = find_banned_words(row.get("description", ""))
        if title_banned or desc_banned:
            banned_violations.append(
                f"Row {idx} (id={row.get('id')}): title matches={title_banned}, desc matches={desc_banned}"
            )

    if banned_violations:
        sample = "\n".join(banned_violations[:5])
        raise ValueError(
            f"{filepath}: found {len(banned_violations)} banned word violations:\n{sample}"
        )

    # Agreement and Cohen's Kappa
    labels_a = df["label_a"].astype(str)
    labels_b = df["label_b"].astype(str)
    raw_agreement = float((labels_a == labels_b).mean())
    kappa = float(cohen_kappa_score(labels_a, labels_b))

    return raw_agreement, kappa


def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    tickets_path = os.path.join(root, "ml", "data", "tickets_v3.csv")
    gold_path = os.path.join(root, "ml", "data", "gold_set.csv")

    print(f"=== Validating tickets_v3: {tickets_path} ===")
    if not os.path.exists(tickets_path):
        raise FileNotFoundError(f"tickets_v3.csv not found at {tickets_path}")
    tickets_df = pd.read_csv(tickets_path)
    validate_tickets(tickets_df, filepath=tickets_path)
    print(f"[OK] tickets_v3.csv passed all checks: 300 rows, valid labels, 0 banned words.")
    label_counts = tickets_df["label"].value_counts().to_dict()
    print(f"     Label distribution: {label_counts}")

    print(f"\n=== Validating gold_set: {gold_path} ===")
    if not os.path.exists(gold_path):
        raise FileNotFoundError(f"gold_set.csv not found at {gold_path}")
    gold_df = pd.read_csv(gold_path)
    raw_agreement, kappa = validate_gold_set(gold_df, filepath=gold_path)
    print(f"[OK] gold_set.csv passed all checks: 15 rows, expected columns, >=3 P1, 0 banned words.")
    print(f"     Final label distribution: {gold_df['final_label'].value_counts().to_dict()}")
    print(f"     Annotator Agreement (label_a vs label_b):")
    print(f"       Raw agreement: {raw_agreement:.4f} ({raw_agreement * 100:.1f}%)")
    print(f"       Cohen's kappa: {kappa:.4f}")

    print("\nAll data validations PASSED successfully.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"VALIDATION FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
