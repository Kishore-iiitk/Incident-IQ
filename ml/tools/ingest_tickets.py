#!/usr/bin/env python3
"""Ingest and validate chatbot-generated incident tickets.

Reads chatbot outputs from ml/data/chat_outputs/<generator_name>/ticket_batch_XX.json.
Merges each ticket with its spec, computes the priority label using the rubric, and filters:
- Missing fields (spec_id, title, description)
- Unknown spec_id
- Banned words (critical, urgent, severe, severity, sev1, sev2, p1, p2, p3, p4, priority, emergency, high priority, low priority, blocker, showstopper)
- Description shorter than 8 words
- Near-duplicates (TF-IDF cosine similarity > 0.90 within or across generators)

Outputs:
- ml/data/tickets_v3.csv
- ml/data/ingest_report.md
"""

import csv
import glob
import json
import os
import re
import sys
from collections import defaultdict

# Ensure repository root is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from ml.rubric import label_from_facts

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

# Regex with word boundaries, matching phrases first
_escaped = [re.escape(w).replace(r"\ ", r"\s+") for w in sorted(BANNED_WORDS, key=len, reverse=True)]
BANNED_REGEX = re.compile(r"\b(" + "|".join(_escaped) + r")\b", re.IGNORECASE)


def find_banned_words(text):
    """Return list of matched banned words in text, if any."""
    if not text:
        return []
    matches = BANNED_REGEX.findall(text)
    return list(dict.fromkeys(m.lower() for m in matches))


def load_specs(specs_dir):
    """Load all specs from ticket_batch_*.json files into a dict keyed by spec_id."""
    specs = {}
    spec_files = glob.glob(os.path.join(specs_dir, "ticket_batch_*.json"))
    for fpath in sorted(spec_files):
        with open(fpath, "r", encoding="utf-8") as f:
            batch = json.load(f)
            for item in batch:
                specs[item["spec_id"]] = item
    return specs


def load_service_catalog(catalog_path):
    """Load service catalog into a dict mapping service name -> service dict."""
    with open(catalog_path, "r", encoding="utf-8") as f:
        services = json.load(f)
    return {s["name"]: s for s in services}


def ingest_tickets(
    chat_outputs_dir="ml/data/chat_outputs",
    specs_dir="ml/data/specs",
    catalog_path="ml/data/service_catalog.json",
    output_csv="ml/data/tickets_v3.csv",
    report_path="ml/data/ingest_report.md"
):
    specs = load_specs(specs_dir)
    catalog = load_service_catalog(catalog_path)

    # Discover candidate files in chat_outputs/<generator_name>/ticket_batch_*.json
    candidate_records = []
    
    if os.path.isdir(chat_outputs_dir):
        for gen_name in sorted(os.listdir(chat_outputs_dir)):
            gen_dir = os.path.join(chat_outputs_dir, gen_name)
            if not os.path.isdir(gen_dir):
                continue
            batch_files = glob.glob(os.path.join(gen_dir, "ticket_batch_*.json"))
            for bfile in sorted(batch_files):
                try:
                    with open(bfile, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        if isinstance(data, list):
                            for item in data:
                                candidate_records.append((gen_name, os.path.basename(bfile), item))
                except Exception as e:
                    print(f"Error reading {bfile}: {e}")

    accepted_rows = []
    rejected_records = []  # list of dicts: {generator, file, spec_id, reason}

    # Pass 1: Structural & Lexical Filters
    stage1_candidates = []
    for gen_name, filename, raw_item in candidate_records:
        spec_id = raw_item.get("spec_id") if isinstance(raw_item, dict) else None
        title = raw_item.get("title", "") if isinstance(raw_item, dict) else ""
        description = raw_item.get("description", "") if isinstance(raw_item, dict) else ""

        # 1. Missing fields
        if not spec_id or not isinstance(title, str) or not title.strip() or not isinstance(description, str) or not description.strip():
            rejected_records.append({
                "spec_id": spec_id or "MISSING_SPEC_ID",
                "generator": gen_name,
                "file": filename,
                "reason": "Missing or empty required field (spec_id, title, or description)"
            })
            continue

        spec_id = spec_id.strip()
        title = title.strip()
        description = description.strip()

        # 2. Unknown spec_id
        if spec_id not in specs:
            rejected_records.append({
                "spec_id": spec_id,
                "generator": gen_name,
                "file": filename,
                "reason": f"Unknown spec_id: '{spec_id}' not found in specifications"
            })
            continue

        # 3. Banned words in title or description
        combined_text = f"{title} {description}"
        banned_found = find_banned_words(combined_text)
        if banned_found:
            rejected_records.append({
                "spec_id": spec_id,
                "generator": gen_name,
                "file": filename,
                "reason": f"Contains banned word(s): {', '.join(banned_found)}"
            })
            continue

        # 4. Description shorter than 8 words
        words = description.split()
        if len(words) < 8:
            rejected_records.append({
                "spec_id": spec_id,
                "generator": gen_name,
                "file": filename,
                "reason": f"Description too short ({len(words)} words; minimum is 8 words)"
            })
            continue

        stage1_candidates.append({
            "spec_id": spec_id,
            "generator": gen_name,
            "file": filename,
            "title": title,
            "description": description,
            "full_text": combined_text
        })

    # Pass 2: Near-duplicate detection (TF-IDF cosine similarity > 0.90)
    accepted_candidates = []
    if stage1_candidates:
        all_texts = [c["full_text"] for c in stage1_candidates]
        vectorizer = TfidfVectorizer(stop_words="english", token_pattern=r"(?u)\b\w+\b")
        tfidf_matrix = vectorizer.fit_transform(all_texts)

        # Incrementally accept rows and compare against already accepted rows
        accepted_indices = []
        for idx, cand in enumerate(stage1_candidates):
            if not accepted_indices:
                accepted_indices.append(idx)
                accepted_candidates.append(cand)
                continue

            current_vec = tfidf_matrix[idx]
            past_vecs = tfidf_matrix[accepted_indices]
            sims = cosine_similarity(current_vec, past_vecs)[0]
            max_sim_idx = sims.argmax()
            max_sim = sims[max_sim_idx]

            if max_sim > 0.90:
                dup_target = stage1_candidates[accepted_indices[max_sim_idx]]
                rejected_records.append({
                    "spec_id": cand["spec_id"],
                    "generator": cand["generator"],
                    "file": cand["file"],
                    "reason": f"Near-duplicate (TF-IDF cosine {max_sim:.3f} > 0.90) with {dup_target['spec_id']} from {dup_target['generator']}"
                })
            else:
                accepted_indices.append(idx)
                accepted_candidates.append(cand)

    # Pass 3: Enrich accepted rows with spec metadata & rubric label
    for cand in accepted_candidates:
        spec = specs[cand["spec_id"]]
        service_name = spec["service"]
        service_info = catalog.get(service_name, {})
        category = service_info.get("category", "Backend")

        label = label_from_facts(
            tier=spec["tier"],
            scope=spec["scope"],
            data_loss=spec["data_loss"],
            workaround=spec["workaround"]
        )

        accepted_rows.append({
            "spec_id": cand["spec_id"],
            "generator": cand["generator"],
            "title": cand["title"],
            "description": cand["description"],
            "service": service_name,
            "category": category,
            "tier": spec["tier"],
            "scope": spec["scope"],
            "data_loss": spec["data_loss"],
            "workaround": spec["workaround"],
            "label": label
        })

    # Write CSV output
    os.makedirs(os.path.dirname(output_csv), exist_ok=True)
    fieldnames = [
        "spec_id",
        "generator",
        "title",
        "description",
        "service",
        "category",
        "tier",
        "scope",
        "data_loss",
        "workaround",
        "label",
    ]
    with open(output_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in accepted_rows:
            writer.writerow(row)

    # Write Markdown Ingestion Report
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as f:
        f.write("# IncidentIQ Ticket Ingestion Report\n\n")
        f.write("## 1. Summary Statistics\n\n")
        f.write(f"- **Total candidates evaluated**: {len(candidate_records)}\n")
        f.write(f"- **Accepted tickets written to CSV**: {len(accepted_rows)}\n")
        f.write(f"- **Total rejected items**: {len(rejected_records)}\n\n")

        # Label counts of accepted tickets
        f.write("### Accepted Priority Distribution\n\n")
        label_counts = defaultdict(int)
        for r in accepted_rows:
            label_counts[r["label"]] += 1
        for lbl in ["P1", "P2", "P3", "P4"]:
            cnt = label_counts[lbl]
            pct = (cnt / len(accepted_rows) * 100) if accepted_rows else 0.0
            f.write(f"- **{lbl}**: {cnt} ({pct:.1f}%)\n")
        f.write("\n")

        # Rejected by Reason
        f.write("## 2. Rejection Summary by Reason\n\n")
        reasons_count = defaultdict(int)
        for r in rejected_records:
            # Group reason prefix
            prefix = r["reason"].split(":")[0]
            reasons_count[prefix] += 1
        for reason_prefix, count in sorted(reasons_count.items(), key=lambda x: -x[1]):
            f.write(f"- **{reason_prefix}**: {count}\n")
        f.write("\n")

        # Rejected Table
        f.write("## 3. Rejected Specs (Action Items for Chatbot Regeneration)\n\n")
        if not rejected_records:
            f.write("*No items were rejected. All candidates passed quality filters.*\n")
        else:
            f.write("| Spec ID | Generator | Batch File | Reason |\n")
            f.write("| :--- | :--- | :--- | :--- |\n")
            for r in rejected_records:
                f.write(f"| `{r['spec_id']}` | {r['generator']} | `{r['file']}` | {r['reason']} |\n")
        f.write("\n")

    print(f"Ingestion complete: {len(accepted_rows)} accepted, {len(rejected_records)} rejected.")
    print(f"Output CSV: {output_csv}")
    print(f"Report: {report_path}")

    return {
        "total": len(candidate_records),
        "accepted": len(accepted_rows),
        "rejected": len(rejected_records),
        "rejected_records": rejected_records
    }


if __name__ == "__main__":
    ingest_tickets()
