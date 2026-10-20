"""Dataset splitting script for Phase 2a.

Rules:
- Seed 42 for reproducibility.
- Generator 'gemini' (100 rows) is held out entirely as test set T2.
- Generators 'chatgpt' and 'claude' (200 rows) are split 80/20 stratified by 'label' into train and val.
- Gold set (15 rows) from ml/data/gold_set.csv is saved as test set T3.
- Target directory: ml/data/splits/{train,val,test_t2,test_t3}.csv
- Prints the label counts for each split.
- Never use T2 or T3 for training or model selection.
"""

import os
import sys
import pandas as pd
from sklearn.model_selection import train_test_split


def make_splits(
    tickets_path: str = None,
    gold_path: str = None,
    output_dir: str = None,
    seed: int = 42,
):
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
    if tickets_path is None:
        tickets_path = os.path.join(root, "ml", "data", "tickets_v3.csv")
    if gold_path is None:
        gold_path = os.path.join(root, "ml", "data", "gold_set.csv")
    if output_dir is None:
        output_dir = os.path.join(root, "ml", "data", "splits")

    os.makedirs(output_dir, exist_ok=True)

    tickets_df = pd.read_csv(tickets_path)
    gold_df = pd.read_csv(gold_path)

    # 1. Hold out generator 'gemini' entirely as test set T2 (100 rows)
    t2_df = tickets_df[tickets_df["generator"] == "gemini"].copy().reset_index(drop=True)
    if len(t2_df) != 100:
        raise ValueError(f"Expected exactly 100 gemini rows for T2, got {len(t2_df)}")

    # 2. Remaining generators ('chatgpt' and 'claude', 200 rows)
    dev_pool = tickets_df[tickets_df["generator"].isin(["chatgpt", "claude"])].copy().reset_index(drop=True)
    if len(dev_pool) != 200:
        raise ValueError(f"Expected 200 chatgpt+claude rows, got {len(dev_pool)}")

    # Split 80/20 stratified by label
    train_df, val_df = train_test_split(
        dev_pool,
        test_size=0.20,
        random_state=seed,
        stratify=dev_pool["label"],
    )
    train_df = train_df.reset_index(drop=True)
    val_df = val_df.reset_index(drop=True)

    # 3. Gold set T3
    t3_df = gold_df.copy().reset_index(drop=True)
    if "label" not in t3_df.columns and "final_label" in t3_df.columns:
        t3_df["label"] = t3_df["final_label"]

    # Save to disk
    train_path = os.path.join(output_dir, "train.csv")
    val_path = os.path.join(output_dir, "val.csv")
    t2_path = os.path.join(output_dir, "test_t2.csv")
    t3_path = os.path.join(output_dir, "test_t3.csv")

    train_df.to_csv(train_path, index=False)
    val_df.to_csv(val_path, index=False)
    t2_df.to_csv(t2_path, index=False)
    t3_df.to_csv(t3_path, index=False)

    print(f"Splits saved to {output_dir}:")
    print(f"  - train.csv:   {len(train_df)} rows")
    print(f"    Label counts: {train_df['label'].value_counts().to_dict()}")
    print(f"  - val.csv:     {len(val_df)} rows")
    print(f"    Label counts: {val_df['label'].value_counts().to_dict()}")
    print(f"  - test_t2.csv: {len(t2_df)} rows (held-out gemini)")
    print(f"    Label counts: {t2_df['label'].value_counts().to_dict()}")
    print(f"  - test_t3.csv: {len(t3_df)} rows (gold set)")
    print(f"    Label counts: {t3_df['label'].value_counts().to_dict()}")

    return train_df, val_df, t2_df, t3_df


if __name__ == "__main__":
    try:
        make_splits()
    except Exception as exc:
        print(f"SPLIT CREATION FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
