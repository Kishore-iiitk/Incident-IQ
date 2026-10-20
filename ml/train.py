"""Phase 2a model training and evaluation script.

Models trained:
  a) majority-class baseline (DummyClassifier)
  b) TF-IDF (1-2 word ngrams, sublinear_tf) + LogisticRegression(class_weight="balanced", max_iter=2000)
  c) Sentence embeddings (all-MiniLM-L6-v2) + LogisticRegression(class_weight="balanced", max_iter=2000)

Evaluation:
  Report accuracy, macro-F1, per-class P/R/F1, and confusion matrix on:
  - validation set (val.csv, 40 rows)
  - held-out generator test set T2 (test_t2.csv, 100 rows)
  - gold set test set T3 (test_t3.csv, 15 rows)

Selection:
  Best model selected STRICTLY by validation macro-F1. T2 and T3 are never used for selection.
"""

import os
import sys

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

import json
import joblib
import numpy as np
import pandas as pd
from typing import Dict, Any, List

from sklearn.dummy import DummyClassifier
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.metrics import (
    accuracy_score,
    f1_score,
    classification_report,
    confusion_matrix,
)

from ml.classifier import SentenceTransformerClassifier, CLASSES


def evaluate_model(model, X: List[str], y_true: List[str]) -> Dict[str, Any]:
    """Compute accuracy, macro-F1, per-class metrics, and confusion matrix."""
    y_pred = model.predict(X)
    acc = float(accuracy_score(y_true, y_pred))
    macro_f1 = float(f1_score(y_true, y_pred, average="macro", zero_division=0))

    report = classification_report(
        y_true,
        y_pred,
        labels=CLASSES,
        output_dict=True,
        zero_division=0,
    )

    per_class = {}
    for cls in CLASSES:
        if cls in report:
            per_class[cls] = {
                "precision": float(round(report[cls]["precision"], 4)),
                "recall": float(round(report[cls]["recall"], 4)),
                "f1": float(round(report[cls]["f1-score"], 4)),
                "support": int(report[cls]["support"]),
            }
        else:
            per_class[cls] = {"precision": 0.0, "recall": 0.0, "f1": 0.0, "support": 0}

    cm = confusion_matrix(y_true, y_pred, labels=CLASSES).tolist()

    return {
        "accuracy": round(acc, 4),
        "macro_f1": round(macro_f1, 4),
        "per_class": per_class,
        "confusion_matrix": cm,
    }


def load_dataset(filepath: str):
    df = pd.read_csv(filepath)
    text = (df["title"].fillna("") + " " + df["description"].fillna("")).tolist()
    labels = df["label"].tolist() if "label" in df.columns else df["final_label"].tolist()
    return text, labels


def format_markdown_results(results: Dict[str, Any], best_model_name: str) -> str:
    lines = [
        "# Phase 2a Severity Classifier Evaluation Results",
        "",
        "## Summary",
        f"- **Best Model by Validation Macro-F1**: `{best_model_name}`",
        f"- **Validation Macro-F1**: {results['models'][best_model_name]['splits']['val']['macro_f1']:.4f}",
        f"- **Validation Accuracy**: {results['models'][best_model_name]['splits']['val']['accuracy']:.4f}",
        "",
        "## Overall Metrics Comparison",
        "",
        "| Model | Val Acc | Val Macro-F1 | T2 (Gemini) Acc | T2 Macro-F1 | T3 (Gold) Acc | T3 Macro-F1 |",
        "| :--- | :---: | :---: | :---: | :---: | :---: | :---: |",
    ]

    for m_name, m_data in results["models"].items():
        if m_data.get("skipped", False):
            lines.append(f"| {m_name} | *SKIPPED* | *SKIPPED* | *SKIPPED* | *SKIPPED* | *SKIPPED* | *SKIPPED* |")
            continue
        v = m_data["splits"]["val"]
        t2 = m_data["splits"]["test_t2"]
        t3 = m_data["splits"]["test_t3"]
        lines.append(
            f"| **{m_name}** | {v['accuracy']:.4f} | {v['macro_f1']:.4f} | {t2['accuracy']:.4f} | {t2['macro_f1']:.4f} | {t3['accuracy']:.4f} | {t3['macro_f1']:.4f} |"
        )

    lines.append("")
    lines.append("## Detailed Performance Breakdown by Model")
    lines.append("")

    for m_name, m_data in results["models"].items():
        if m_data.get("skipped", False):
            lines.append(f"### {m_name}")
            lines.append(f"Status: Skipped ({m_data.get('skip_reason', 'N/A')})\n")
            continue

        lines.append(f"### Model: {m_name}")
        for s_name, s_title in [("val", "Validation Set (40 rows)"), ("test_t2", "Test T2 - Held-out Gemini (100 rows)"), ("test_t3", "Test T3 - Gold Set (15 rows)")]:
            s_data = m_data["splits"][s_name]
            lines.append(f"#### {s_title}")
            lines.append(f"- **Accuracy**: {s_data['accuracy']:.4f}")
            lines.append(f"- **Macro-F1**: {s_data['macro_f1']:.4f}")
            lines.append("")
            lines.append("| Class | Precision | Recall | F1-Score | Support |")
            lines.append("| :--- | :---: | :---: | :---: | :---: |")
            for cls in CLASSES:
                pc = s_data["per_class"][cls]
                lines.append(f"| {cls} | {pc['precision']:.4f} | {pc['recall']:.4f} | {pc['f1']:.4f} | {pc['support']} |")
            lines.append("")
            lines.append("Confusion Matrix (Rows: True [P1..P4], Cols: Pred [P1..P4]):")
            lines.append("```")
            cm = s_data["confusion_matrix"]
            header = "True \\ Pred  " + "  ".join(f"{c:>4}" for c in CLASSES)
            lines.append(header)
            for i, c in enumerate(CLASSES):
                row_str = f"{c:<10} " + "  ".join(f"{cm[i][j]:>4}" for j in range(len(CLASSES)))
                lines.append(row_str)
            lines.append("```")
            lines.append("")

    lines.extend([
        "## Methodological & Honest Note on Sample Sizes and Synthetic Labels",
        "",
        "> [!IMPORTANT]",
        "> 1. **Sample Size Limitations**: The Gold Set (T3) contains only 15 curated rows. While valuable as an independent human-vetted anchor, individual misclassifications result in large (~6.7%) swings in accuracy or recall. Metrics on T3 must be interpreted as qualitative directional indicators rather than high-statistical-power benchmarks.",
        "> 2. **Synthetic Rubric Bias**: The training, validation, and T2 datasets (tickets_v3.csv) originate from deterministic synthetic specs derived from an incident rubric. Although generator diversity (ChatGPT, Claude, Gemini) reduces prompt-specific artifacts, models may capture synthetic generation stylistic regularities. Validation macro-F1 was used strictly for model selection, keeping T2 and T3 strictly held-out.",
        "",
    ])

    return "\n".join(lines)


def train_and_evaluate():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    splits_dir = os.path.join(root, "ml", "data", "splits")
    models_dir = os.path.join(root, "ml", "models")
    results_dir = os.path.join(root, "ml", "results")

    os.makedirs(models_dir, exist_ok=True)
    os.makedirs(results_dir, exist_ok=True)

    # 1. Load splits
    X_train, y_train = load_dataset(os.path.join(splits_dir, "train.csv"))
    X_val, y_val = load_dataset(os.path.join(splits_dir, "val.csv"))
    X_t2, y_t2 = load_dataset(os.path.join(splits_dir, "test_t2.csv"))
    X_t3, y_t3 = load_dataset(os.path.join(splits_dir, "test_t3.csv"))

    print(f"Loaded datasets:")
    print(f"  Train:   {len(X_train)} samples")
    print(f"  Val:     {len(X_val)} samples")
    print(f"  Test T2: {len(X_t2)} samples")
    print(f"  Test T3: {len(X_t3)} samples")

    results = {
        "models": {},
        "selection_metric": "val_macro_f1",
        "best_model": None,
    }

    # Model a: Majority class baseline
    print("\n--- Training Model A: Majority Class Baseline ---")
    majority_clf = DummyClassifier(strategy="most_frequent")
    majority_clf.fit(X_train, y_train)
    maj_val = evaluate_model(majority_clf, X_val, y_val)
    maj_t2 = evaluate_model(majority_clf, X_t2, y_t2)
    maj_t3 = evaluate_model(majority_clf, X_t3, y_t3)

    results["models"]["majority_baseline"] = {
        "description": "Majority class baseline (DummyClassifier)",
        "splits": {
            "val": maj_val,
            "test_t2": maj_t2,
            "test_t3": maj_t3,
        },
    }
    joblib.dump(majority_clf, os.path.join(models_dir, "majority_baseline.joblib"))
    print(f"Majority Baseline Val Macro-F1: {maj_val['macro_f1']:.4f}, Val Acc: {maj_val['accuracy']:.4f}")

    # Model b: TF-IDF + LogisticRegression
    print("\n--- Training Model B: TF-IDF + Logistic Regression ---")
    tfidf_pipe = Pipeline([
        ("tfidf", TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True)),
        ("clf", LogisticRegression(class_weight="balanced", max_iter=2000, random_state=42)),
    ])
    tfidf_pipe.fit(X_train, y_train)
    tfidf_val = evaluate_model(tfidf_pipe, X_val, y_val)
    tfidf_t2 = evaluate_model(tfidf_pipe, X_t2, y_t2)
    tfidf_t3 = evaluate_model(tfidf_pipe, X_t3, y_t3)

    results["models"]["tfidf_logreg"] = {
        "description": "TF-IDF (1-2 word ngrams, sublinear_tf) + LogisticRegression(balanced)",
        "splits": {
            "val": tfidf_val,
            "test_t2": tfidf_t2,
            "test_t3": tfidf_t3,
        },
    }
    joblib.dump(tfidf_pipe, os.path.join(models_dir, "tfidf_logreg.joblib"))
    print(f"TF-IDF LogReg Val Macro-F1: {tfidf_val['macro_f1']:.4f}, Val Acc: {tfidf_val['accuracy']:.4f}")

    # Model c: Sentence embeddings + Logistic Regression
    print("\n--- Training Model C: Sentence Embeddings + Logistic Regression ---")
    emb_model = None
    embedding_provider = None
    try:
        from sentence_transformers import SentenceTransformer
        emb_model = SentenceTransformerClassifier(
            model_name="all-MiniLM-L6-v2",
            class_weight="balanced",
            max_iter=2000,
            random_state=42,
        )
        embedding_provider = "sentence-transformers/all-MiniLM-L6-v2"
        emb_model.fit(X_train, y_train)
        emb_val = evaluate_model(emb_model, X_val, y_val)
        emb_t2 = evaluate_model(emb_model, X_t2, y_t2)
        emb_t3 = evaluate_model(emb_model, X_t3, y_t3)

        results["models"]["sentence_transformer_logreg"] = {
            "description": f"Sentence embeddings ({embedding_provider}) + LogisticRegression(balanced)",
            "provider": embedding_provider,
            "splits": {
                "val": emb_val,
                "test_t2": emb_t2,
                "test_t3": emb_t3,
            },
        }
        joblib.dump(emb_model, os.path.join(models_dir, "sentence_transformer_logreg.joblib"))
        print(f"SentenceTransformer LogReg Val Macro-F1: {emb_val['macro_f1']:.4f}, Val Acc: {emb_val['accuracy']:.4f}")
    except Exception as e:
        print(f"SentenceTransformer failed: {e}. Checking Gemini API key fallback...", file=sys.stderr)
        gemini_key = os.environ.get("GEMINI_API_KEY")
        if gemini_key:
            # We would use gemini embedding fallback
            print("GEMINI_API_KEY set, but skipping sentence_transformers failure fallback for now", file=sys.stderr)
            results["models"]["sentence_transformer_logreg"] = {
                "description": "Sentence embeddings + LogisticRegression",
                "skipped": True,
                "skip_reason": f"SentenceTransformers failed: {e}",
            }
        else:
            results["models"]["sentence_transformer_logreg"] = {
                "description": "Sentence embeddings + LogisticRegression",
                "skipped": True,
                "skip_reason": f"SentenceTransformers unavailable ({e}) and GEMINI_API_KEY not set",
            }

    # Best model selection STRICTLY by validation macro-F1
    best_name = None
    best_val_macro_f1 = -1.0
    for name, m_info in results["models"].items():
        if m_info.get("skipped", False):
            continue
        v_f1 = m_info["splits"]["val"]["macro_f1"]
        if v_f1 > best_val_macro_f1:
            best_val_macro_f1 = v_f1
            best_name = name

    results["best_model"] = best_name
    results["best_model_val_macro_f1"] = best_val_macro_f1
    print(f"\n=======================================================")
    print(f"BEST MODEL BY VALIDATION MACRO-F1: {best_name} ({best_val_macro_f1:.4f})")
    print(f"=======================================================")

    # Save best model copy to ml/models/best_model.joblib and metadata.json
    best_obj = joblib.load(os.path.join(models_dir, f"{best_name}.joblib"))
    joblib.dump(best_obj, os.path.join(models_dir, "best_model.joblib"))

    metadata = {
        "best_model_name": best_name,
        "best_model_file": f"{best_name}.joblib",
        "validation_macro_f1": best_val_macro_f1,
        "validation_accuracy": results["models"][best_name]["splits"]["val"]["accuracy"],
        "embedding_provider": results["models"][best_name].get("provider", None),
        "classes": CLASSES,
    }
    with open(os.path.join(models_dir, "model_metadata.json"), "w") as f:
        json.dump(metadata, f, indent=2)

    # Save results JSON
    json_path = os.path.join(results_dir, "phase2a_results.json")
    with open(json_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"Saved results JSON: {json_path}")

    # Save results Markdown
    md_content = format_markdown_results(results, best_name)
    md_path = os.path.join(results_dir, "phase2a_results.md")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write(md_content)
    print(f"Saved results Markdown: {md_path}")

    return results


if __name__ == "__main__":
    train_and_evaluate()
