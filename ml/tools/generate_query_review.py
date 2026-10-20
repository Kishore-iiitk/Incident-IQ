"""Generate ml/results/retrieval_query_review.md."""

import json
import os
import sys

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

from ml.tools.validate_queries import longest_common_consecutive_run, tokenize_words


def main():
    queries_path = os.path.join(ROOT_DIR, "ml", "data", "retrieval_queries.json")
    kb_path = os.path.join(ROOT_DIR, "ml", "data", "chat_outputs", "kb", "kb_batch_01.json")
    out_path = os.path.join(ROOT_DIR, "ml", "results", "retrieval_query_review.md")

    with open(queries_path, "r", encoding="utf-8") as f:
        queries = json.load(f)

    with open(kb_path, "r", encoding="utf-8") as f:
        kb = json.load(f)

    kb_map = {item["id"]: item for item in kb}

    md_lines = [
        "# Retrieval Query Review Document",
        "",
        "This document lists each evaluation query alongside the target historical incident in the Knowledge Base (title, service, family, and symptoms).",
        "Two teammates can use this document to confirm by eye that the semantic match is reasonable, realistic, and representative of customer reports and telemetry alerts.",
        "",
        "## Summary Table",
        "",
        "| Query ID | Expected KB ID | Family | Service | Incident Title | Overlap Run | Flagged (>=4 words)? |",
        "|---|---|---|---|---|---|---|",
    ]

    entries = []
    for q in queries:
        target = kb_map[q["expected_kb_id"]]
        target_text = f"{target['title']} {target['symptoms']}"
        q_tokens = tokenize_words(q["query"])
        t_tokens = tokenize_words(target_text)
        run_len, phrase = longest_common_consecutive_run(q_tokens, t_tokens)
        phrase_str = " ".join(phrase) if phrase else "None"
        flagged = "FLAGGED" if run_len >= 4 else "OK"
        md_lines.append(
            f"| {q['query_id']} | {q['expected_kb_id']} | `{target['family']}` | `{target['service']}` | "
            f"{target['title']} | {run_len} words (`{phrase_str}`) | **{flagged}** |"
        )

        entries.append(
            {
                "qid": q["query_id"],
                "expected_id": q["expected_kb_id"],
                "family": target["family"],
                "service": target["service"],
                "title": target["title"],
                "symptoms": target["symptoms"],
                "query": q["query"],
                "run_len": run_len,
                "phrase": phrase_str,
                "flagged": flagged,
            }
        )

    md_lines.append("")
    md_lines.append("---")
    md_lines.append("")
    md_lines.append("## Detailed Pairwise Review")
    md_lines.append("")

    for e in entries:
        md_lines.append(f"### {e['qid']} &rarr; {e['expected_id']}: {e['title']}")
        md_lines.append(f"- **Family**: `{e['family']}`")
        md_lines.append(f"- **Service**: `{e['service']}`")
        md_lines.append(f"- **Longest Shared Word Run**: {e['run_len']} words (*\"{e['phrase']}\"*)")
        if e["flagged"] == "FLAGGED":
            md_lines.append(f"> [!WARNING]")
            md_lines.append(
                f"> **Consecutive Word Run Flag**: Shared phrase has {e['run_len']} consecutive words (*\"{e['phrase']}\"*). "
                f"Reviewers should verify that this domain terminology is natural in real alerts rather than an verbatim leak."
            )
        md_lines.append("")
        md_lines.append("**Query Text:**")
        md_lines.append(f"> {e['query']}")
        md_lines.append("")
        md_lines.append("**Expected Incident Symptoms:**")
        md_lines.append(f"> {e['symptoms']}")
        md_lines.append("")
        md_lines.append("**Reviewer Confirmation:**")
        md_lines.append("- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.")
        md_lines.append("- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.")
        md_lines.append("")
        md_lines.append("---")
        md_lines.append("")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(md_lines))

    print(f"Generated {out_path} ({len(entries)} items)")


if __name__ == "__main__":
    main()
