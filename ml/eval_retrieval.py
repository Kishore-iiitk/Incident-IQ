"""Evaluation script for incident retrieval (BM25 vs Vector Search).

Evaluates:
- BM25 (BM25Okapi over title + symptoms)
- Vector Search (all-MiniLM-L6-v2 cosine similarity over title + symptoms)

Metrics reported:
- Recall@1, Recall@3, Recall@5
- MRR (Mean Reciprocal Rank)
- Sibling-confusion rate (top-1 wrong but same family as expected)
- Cross-family error rate (top-1 in different family)
- Per-family metric breakdown
- Real vs Negative query score comparison and recommended threshold

Saves:
- ml/results/retrieval_results.json
- ml/results/retrieval_results.md
"""

import json
import math
import os
import re
import sys
from collections import Counter
from typing import Any, Dict, List, Tuple

import numpy as np

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)


# =====================================================================
# 1. Pure Metric Functions (Tested with known unit tests)
# =====================================================================

def compute_recall_at_k(ranked_ids_list: List[List[str]], expected_ids: List[str], k: int) -> float:
    """Compute Recall@k for single-target retrieval across queries."""
    if not expected_ids:
        return 0.0
    hits = 0
    for ranked, expected in zip(ranked_ids_list, expected_ids):
        if expected in ranked[:k]:
            hits += 1
    return hits / len(expected_ids)


def compute_mrr(ranked_ids_list: List[List[str]], expected_ids: List[str]) -> float:
    """Compute Mean Reciprocal Rank (MRR) across queries."""
    if not expected_ids:
        return 0.0
    total_rr = 0.0
    for ranked, expected in zip(ranked_ids_list, expected_ids):
        if expected in ranked:
            rank = ranked.index(expected) + 1
            total_rr += 1.0 / rank
        else:
            total_rr += 0.0
    return total_rr / len(expected_ids)


def compute_sibling_confusion(
    ranked_ids_list: List[List[str]],
    expected_ids: List[str],
    id_to_family: Dict[str, str],
) -> float:
    """Fraction of queries where top-1 is incorrect but belongs to the SAME family as expected incident."""
    if not expected_ids:
        return 0.0
    confusion_count = 0
    for ranked, expected in zip(ranked_ids_list, expected_ids):
        if not ranked:
            continue
        top1 = ranked[0]
        if top1 != expected:
            expected_fam = id_to_family.get(expected)
            top1_fam = id_to_family.get(top1)
            if expected_fam is not None and expected_fam == top1_fam:
                confusion_count += 1
    return confusion_count / len(expected_ids)


def compute_cross_family_error(
    ranked_ids_list: List[List[str]],
    expected_ids: List[str],
    id_to_family: Dict[str, str],
) -> float:
    """Fraction of queries where top-1 belongs to a DIFFERENT family than expected incident."""
    if not expected_ids:
        return 0.0
    error_count = 0
    for ranked, expected in zip(ranked_ids_list, expected_ids):
        if not ranked:
            continue
        top1 = ranked[0]
        expected_fam = id_to_family.get(expected)
        top1_fam = id_to_family.get(top1)
        if expected_fam != top1_fam:
            error_count += 1
    return error_count / len(expected_ids)


def compute_all_metrics(
    ranked_ids_list: List[List[str]],
    expected_ids: List[str],
    id_to_family: Dict[str, str],
) -> Dict[str, float]:
    """Compute full set of retrieval evaluation metrics."""
    return {
        "recall_at_1": compute_recall_at_k(ranked_ids_list, expected_ids, 1),
        "recall_at_3": compute_recall_at_k(ranked_ids_list, expected_ids, 3),
        "recall_at_5": compute_recall_at_k(ranked_ids_list, expected_ids, 5),
        "mrr": compute_mrr(ranked_ids_list, expected_ids),
        "sibling_confusion_rate": compute_sibling_confusion(ranked_ids_list, expected_ids, id_to_family),
        "cross_family_error_rate": compute_cross_family_error(ranked_ids_list, expected_ids, id_to_family),
    }


# =====================================================================
# 2. BM25 Okapi Implementation
# =====================================================================

def tokenize_bm25(text: str) -> List[str]:
    """Simple lowercase regex word tokenization."""
    return re.findall(r"\b[a-zA-Z0-9_\-]+\b", text.lower())


class BM25Okapi:
    """Standard BM25Okapi ranking implementation."""

    def __init__(self, corpus_tokens: List[List[str]], k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.corpus_size = len(corpus_tokens)
        self.doc_len = [len(doc) for doc in corpus_tokens]
        self.avgdl = sum(self.doc_len) / self.corpus_size if self.corpus_size > 0 else 1.0

        self.doc_freqs: List[Counter] = []
        nd: Dict[str, int] = {}
        for doc in corpus_tokens:
            counts = Counter(doc)
            self.doc_freqs.append(counts)
            for word in counts.keys():
                nd[word] = nd.get(word, 0) + 1

        self.idf: Dict[str, float] = {}
        for word, freq in nd.items():
            # Standard Lucene/BM25Okapi IDF
            self.idf[word] = math.log(1.0 + (self.corpus_size - freq + 0.5) / (freq + 0.5))

    def get_scores(self, query_tokens: List[str]) -> List[float]:
        scores = [0.0] * self.corpus_size
        for q in query_tokens:
            if q not in self.idf:
                continue
            idf_val = self.idf[q]
            for i, doc_freq in enumerate(self.doc_freqs):
                freq = doc_freq.get(q, 0)
                if freq > 0:
                    numerator = freq * (self.k1 + 1.0)
                    denominator = freq + self.k1 * (1.0 - self.b + self.b * (self.doc_len[i] / self.avgdl))
                    scores[i] += idf_val * (numerator / denominator)
        return scores


# =====================================================================
# 3. Main Evaluation Pipeline
# =====================================================================

def run_evaluation() -> Dict[str, Any]:
    # Paths
    kb_path = os.path.join(ROOT_DIR, "server", "rag", "kb_index.json")
    if not os.path.exists(kb_path):
        kb_path = os.path.join(ROOT_DIR, "ml", "data", "chat_outputs", "kb", "kb_batch_01.json")

    queries_path = os.path.join(ROOT_DIR, "ml", "data", "retrieval_queries.json")
    negative_path = os.path.join(ROOT_DIR, "ml", "data", "retrieval_negative_queries.json")

    with open(kb_path, "r", encoding="utf-8") as f:
        kb_raw = json.load(f)
    incidents = kb_raw.get("incidents", kb_raw) if isinstance(kb_raw, dict) else kb_raw

    with open(queries_path, "r", encoding="utf-8") as f:
        queries = json.load(f)

    with open(negative_path, "r", encoding="utf-8") as f:
        negative_queries = json.load(f)

    id_to_incident = {item["id"]: item for item in incidents}
    id_to_family = {item["id"]: item["family"] for item in incidents}
    incident_ids = [item["id"] for item in incidents]
    incident_texts = [f"{item['title']} {item['symptoms']}" for item in incidents]

    # --- Method A: BM25 ---
    bm25_corpus = [tokenize_bm25(text) for text in incident_texts]
    bm25_model = BM25Okapi(bm25_corpus)

    bm25_ranked_ids: List[List[str]] = []
    bm25_top3_details: List[List[Dict[str, Any]]] = []

    for q in queries:
        q_tokens = tokenize_bm25(q["query"])
        scores = bm25_model.get_scores(q_tokens)
        sorted_indices = np.argsort(scores)[::-1]
        ranked = [incident_ids[idx] for idx in sorted_indices]
        bm25_ranked_ids.append(ranked)

        top3 = []
        for rank_pos, idx in enumerate(sorted_indices[:3], start=1):
            top3.append({
                "rank": rank_pos,
                "id": incident_ids[idx],
                "title": id_to_incident[incident_ids[idx]]["title"],
                "family": id_to_incident[incident_ids[idx]]["family"],
                "score": round(float(scores[idx]), 4),
                "is_expected": incident_ids[idx] == q["expected_kb_id"]
            })
        bm25_top3_details.append(top3)

    # --- Method B: Vector Search ---
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer("all-MiniLM-L6-v2")

    # KB vectors
    kb_embeddings = np.array([item["embedding"] for item in incidents], dtype=np.float32)
    kb_norms = np.linalg.norm(kb_embeddings, axis=1, keepdims=True)
    kb_normalized = kb_embeddings / np.where(kb_norms == 0, 1.0, kb_norms)

    # Real query vectors
    query_texts = [q["query"] for q in queries]
    query_embeddings = model.encode(query_texts, convert_to_numpy=True)
    query_norms = np.linalg.norm(query_embeddings, axis=1, keepdims=True)
    query_normalized = query_embeddings / np.where(query_norms == 0, 1.0, query_norms)

    sim_matrix = np.dot(query_normalized, kb_normalized.T)  # (15, 30)

    vector_ranked_ids: List[List[str]] = []
    vector_top3_details: List[List[Dict[str, Any]]] = []
    real_top1_scores: List[float] = []

    for q_idx, q in enumerate(queries):
        scores = sim_matrix[q_idx]
        sorted_indices = np.argsort(scores)[::-1]
        ranked = [incident_ids[idx] for idx in sorted_indices]
        vector_ranked_ids.append(ranked)

        real_top1_scores.append(float(scores[sorted_indices[0]]))

        top3 = []
        for rank_pos, idx in enumerate(sorted_indices[:3], start=1):
            top3.append({
                "rank": rank_pos,
                "id": incident_ids[idx],
                "title": id_to_incident[incident_ids[idx]]["title"],
                "family": id_to_incident[incident_ids[idx]]["family"],
                "score": round(float(scores[idx]), 4),
                "is_expected": incident_ids[idx] == q["expected_kb_id"]
            })
        vector_top3_details.append(top3)

    # Negative Queries Vector Search
    neg_texts = [nq["query"] for nq in negative_queries]
    neg_embeddings = model.encode(neg_texts, convert_to_numpy=True)
    neg_norms = np.linalg.norm(neg_embeddings, axis=1, keepdims=True)
    neg_normalized = neg_embeddings / np.where(neg_norms == 0, 1.0, neg_norms)

    neg_sim_matrix = np.dot(neg_normalized, kb_normalized.T)
    neg_top1_scores: List[float] = []
    neg_top1_details: List[Dict[str, Any]] = []

    for n_idx, nq in enumerate(negative_queries):
        scores = neg_sim_matrix[n_idx]
        best_idx = int(np.argmax(scores))
        best_score = float(scores[best_idx])
        neg_top1_scores.append(best_score)
        neg_top1_details.append({
            "query_id": nq["query_id"],
            "query": nq["query"],
            "category": nq.get("category", ""),
            "top1_id": incident_ids[best_idx],
            "top1_title": id_to_incident[incident_ids[best_idx]]["title"],
            "top1_score": round(best_score, 4)
        })

    # Expected IDs
    expected_ids = [q["expected_kb_id"] for q in queries]

    # --- Compute Overall Metrics ---
    bm25_metrics = compute_all_metrics(bm25_ranked_ids, expected_ids, id_to_family)
    vector_metrics = compute_all_metrics(vector_ranked_ids, expected_ids, id_to_family)

    # --- Per-Family Metrics ---
    families = sorted(list(set(id_to_family.values())))
    per_family_results = {}

    for fam in families:
        fam_indices = [idx for idx, q in enumerate(queries) if id_to_family[q["expected_kb_id"]] == fam]
        if not fam_indices:
            continue

        fam_expected = [expected_ids[idx] for idx in fam_indices]
        fam_bm25_ranked = [bm25_ranked_ids[idx] for idx in fam_indices]
        fam_vector_ranked = [vector_ranked_ids[idx] for idx in fam_indices]

        per_family_results[fam] = {
            "query_count": len(fam_indices),
            "bm25": compute_all_metrics(fam_bm25_ranked, fam_expected, id_to_family),
            "vector": compute_all_metrics(fam_vector_ranked, fam_expected, id_to_family),
        }

    # --- Threshold Recommendations ---
    min_real_score = min(real_top1_scores)
    max_real_score = max(real_top1_scores)
    min_neg_score = min(neg_top1_scores)
    max_neg_score = max(neg_top1_scores)

    overlap = not (max_neg_score < min_real_score)
    recommended_threshold = round((max_neg_score + min_real_score) / 2.0, 2)
    # If 0.41 sits cleanly between max_neg (0.4087) and min_real (0.4139):
    if max_neg_score <= 0.41 <= min_real_score:
        recommended_threshold = 0.41

    results_payload = {
        "metadata": {
            "num_queries": len(queries),
            "num_incidents": len(incidents),
            "num_negative_queries": len(negative_queries),
            "significance_note": "With 15 queries and 30 incidents, 1 query corresponds to ~6.67 percentage points. Differences between methods may not be statistically significant."
        },
        "overall_metrics": {
            "bm25": bm25_metrics,
            "vector": vector_metrics,
        },
        "per_family_metrics": per_family_results,
        "score_threshold_analysis": {
            "real_top1_range": [round(min_real_score, 4), round(max_real_score, 4)],
            "negative_top1_range": [round(min_neg_score, 4), round(max_neg_score, 4)],
            "ranges_overlap": overlap,
            "recommended_rag_min_score": recommended_threshold,
            "negative_top1_details": neg_top1_details,
        },
        "query_evaluations": [
            {
                "query_id": q["query_id"],
                "expected_kb_id": q["expected_kb_id"],
                "expected_title": id_to_incident[q["expected_kb_id"]]["title"],
                "family": id_to_family[q["expected_kb_id"]],
                "query_text": q["query"],
                "bm25_top3": bm25_top3_details[i],
                "vector_top3": vector_top3_details[i],
                "bm25_correct_top1": bm25_ranked_ids[i][0] == q["expected_kb_id"],
                "vector_correct_top1": vector_ranked_ids[i][0] == q["expected_kb_id"],
            }
            for i, q in enumerate(queries)
        ],
    }

    # Save JSON results
    results_json_path = os.path.join(ROOT_DIR, "ml", "results", "retrieval_results.json")
    os.makedirs(os.path.dirname(results_json_path), exist_ok=True)
    with open(results_json_path, "w", encoding="utf-8") as f:
        json.dump(results_payload, f, indent=2)

    # Save Markdown results
    results_md_path = os.path.join(ROOT_DIR, "ml", "results", "retrieval_results.md")
    render_markdown_report(results_payload, results_md_path)

    return results_payload


def render_markdown_report(data: Dict[str, Any], filepath: str) -> None:
    bm = data["overall_metrics"]["bm25"]
    vec = data["overall_metrics"]["vector"]
    thresh = data["score_threshold_analysis"]

    md = []
    md.append("# Phase 2c Retrieval Evaluation Report")
    md.append("")
    md.append("> [!NOTE]")
    md.append(f"> **Sample Size & Statistical Significance**: {data['metadata']['significance_note']}")
    md.append("")
    md.append("## 1. Overall Metrics: BM25 vs Vector Search")
    md.append("")
    md.append("| Metric | BM25 | Vector Search (`all-MiniLM-L6-v2`) | Difference (Vector - BM25) |")
    md.append("|---|---|---|---|")
    md.append(f"| **Recall@1** | {bm['recall_at_1']:.4f} ({bm['recall_at_1']*100:.1f}%) | {vec['recall_at_1']:.4f} ({vec['recall_at_1']*100:.1f}%) | {(vec['recall_at_1'] - bm['recall_at_1'])*100:+.1f}% |")
    md.append(f"| **Recall@3** | {bm['recall_at_3']:.4f} ({bm['recall_at_3']*100:.1f}%) | {vec['recall_at_3']:.4f} ({vec['recall_at_3']*100:.1f}%) | {(vec['recall_at_3'] - bm['recall_at_3'])*100:+.1f}% |")
    md.append(f"| **Recall@5** | {bm['recall_at_5']:.4f} ({bm['recall_at_5']*100:.1f}%) | {vec['recall_at_5']:.4f} ({vec['recall_at_5']*100:.1f}%) | {(vec['recall_at_5'] - bm['recall_at_5'])*100:+.1f}% |")
    md.append(f"| **MRR** | {bm['mrr']:.4f} | {vec['mrr']:.4f} | {vec['mrr'] - bm['mrr']:+.4f} |")
    md.append(f"| **Sibling Confusion Rate** | {bm['sibling_confusion_rate']:.4f} ({bm['sibling_confusion_rate']*100:.1f}%) | {vec['sibling_confusion_rate']:.4f} ({vec['sibling_confusion_rate']*100:.1f}%) | {(vec['sibling_confusion_rate'] - bm['sibling_confusion_rate'])*100:+.1f}% |")
    md.append(f"| **Cross-Family Error Rate** | {bm['cross_family_error_rate']:.4f} ({bm['cross_family_error_rate']*100:.1f}%) | {vec['cross_family_error_rate']:.4f} ({vec['cross_family_error_rate']*100:.1f}%) | {(vec['cross_family_error_rate'] - bm['cross_family_error_rate'])*100:+.1f}% |")
    md.append("")
    md.append("## 2. Per-Family Breakdown")
    md.append("")
    md.append("| Family | Queries | BM25 Recall@1 | BM25 Recall@3 | Vector Recall@1 | Vector Recall@3 | Vector Sibling Conf | Vector Cross-Fam Err |")
    md.append("|---|---|---|---|---|---|---|---|")

    for fam, f_data in data["per_family_metrics"].items():
        f_bm = f_data["bm25"]
        f_vec = f_data["vector"]
        md.append(
            f"| `{fam}` | {f_data['query_count']} | "
            f"{f_bm['recall_at_1']:.2f} | {f_bm['recall_at_3']:.2f} | "
            f"{f_vec['recall_at_1']:.2f} | {f_vec['recall_at_3']:.2f} | "
            f"{f_vec['sibling_confusion_rate']:.2f} | {f_vec['cross_family_error_rate']:.2f} |"
        )

    md.append("")
    md.append("## 3. Score Threshold & Negative Query Analysis")
    md.append("")
    md.append(f"- **Real Query Top-1 Score Range**: `[{thresh['real_top1_range'][0]}, {thresh['real_top1_range'][1]}]`")
    md.append(f"- **Negative Query Top-1 Score Range**: `[{thresh['negative_top1_range'][0]}, {thresh['negative_top1_range'][1]}]`")
    md.append(f"- **Overlap Between Ranges**: {'YES (overlapping)' if thresh['ranges_overlap'] else 'NO (strictly separated)'}")
    md.append(f"- **Recommended `RAG_MIN_SCORE`**: `{thresh['recommended_rag_min_score']}`")
    md.append("")
    md.append("### Negative Query Breakdown")
    md.append("")
    md.append("| Query ID | Category | Negative Query Text | Top-1 Nearest Incident | Top-1 Cosine Score | Threshold Decision |")
    md.append("|---|---|---|---|---|---|")
    for n in thresh["negative_top1_details"]:
        status = "Dropped (< 0.41)" if n["top1_score"] < thresh["recommended_rag_min_score"] else "Retained (>= 0.41)"
        md.append(f"| {n['query_id']} | `{n['category']}` | \"{n['query']}\" | {n['top1_id']} ({n['top1_title']}) | **{n['top1_score']}** | {status} |")

    md.append("")
    md.append("## 4. Per-Query Retrieval Details")
    md.append("")
    md.append("| Query ID | Target KB | Family | BM25 Top-1 (Score) | BM25 Correct? | Vector Top-1 (Score) | Vector Correct? |")
    md.append("|---|---|---|---|---|---|---|")

    for qe in data["query_evaluations"]:
        bm_top = qe["bm25_top3"][0]
        vec_top = qe["vector_top3"][0]
        bm_ok = "PASS" if qe["bm25_correct_top1"] else f"FAIL ({bm_top['id']})"
        vec_ok = "PASS" if qe["vector_correct_top1"] else f"FAIL ({vec_top['id']})"
        md.append(
            f"| {qe['query_id']} | `{qe['expected_kb_id']}` | `{qe['family']}` | "
            f"{bm_top['id']} ({bm_top['score']:.2f}) | {bm_ok} | "
            f"{vec_top['id']} ({vec_top['score']:.4f}) | {vec_ok} |"
        )

    md.append("")
    md.append("### Error Analysis for Failed Queries")
    md.append("")
    for qe in data["query_evaluations"]:
        if not qe["vector_correct_top1"] or not qe["bm25_correct_top1"]:
            md.append(f"#### {qe['query_id']} (Expected `{qe['expected_kb_id']}` - {qe['expected_title']})")
            md.append(f"- **Query**: \"{qe['query_text']}\"")
            if not qe["bm25_correct_top1"]:
                md.append(f"- **BM25 Failure**: Top-1 returned `{qe['bm25_top3'][0]['id']}` ({qe['bm25_top3'][0]['title']}) with score {qe['bm25_top3'][0]['score']:.2f}.")
            if not qe["vector_correct_top1"]:
                top1_vec = qe["vector_top3"][0]
                same_fam = top1_vec["family"] == qe["family"]
                err_type = "Sibling Confusion (same family)" if same_fam else "Cross-Family Error"
                md.append(f"- **Vector Failure ({err_type})**: Top-1 returned `{top1_vec['id']}` ({top1_vec['title']}) with score {top1_vec['score']:.4f} vs expected `{qe['expected_kb_id']}` at rank {[x['id'] for x in qe['vector_top3']].index(qe['expected_kb_id']) + 1 if qe['expected_kb_id'] in [x['id'] for x in qe['vector_top3']] else '>3'}.")
            md.append("")

    with open(filepath, "w", encoding="utf-8") as f:
        f.write("\n".join(md))


def main():
    print("==================================================")
    print("Incident-IQ Retrieval Evaluation (BM25 vs Vector)")
    print("==================================================")
    results = run_evaluation()

    bm = results["overall_metrics"]["bm25"]
    vec = results["overall_metrics"]["vector"]

    print("\n--- Overall Metrics Summary ---")
    print(f"{'Metric':<25} | {'BM25':<12} | {'Vector Search':<12}")
    print("-" * 55)
    for k in ["recall_at_1", "recall_at_3", "recall_at_5", "mrr", "sibling_confusion_rate", "cross_family_error_rate"]:
        print(f"{k:<25} | {bm[k]:<12.4f} | {vec[k]:<12.4f}")

    print("\n--- Per-Family Recall@1 & Recall@3 ---")
    for fam, f_data in results["per_family_metrics"].items():
        print(f"  {fam:<22} (N={f_data['query_count']}):")
        print(f"    BM25:   R@1={f_data['bm25']['recall_at_1']:.2f}, R@3={f_data['bm25']['recall_at_3']:.2f}")
        print(f"    Vector: R@1={f_data['vector']['recall_at_1']:.2f}, R@3={f_data['vector']['recall_at_3']:.2f}")

    thresh = results["score_threshold_analysis"]
    print("\n--- Score Threshold Analysis ---")
    print(f"Real queries Top-1 score range:     {thresh['real_top1_range']}")
    print(f"Negative queries Top-1 score range: {thresh['negative_top1_range']}")
    print(f"Ranges overlap:                     {thresh['ranges_overlap']}")
    print(f"Recommended RAG_MIN_SCORE:          {thresh['recommended_rag_min_score']}")

    print("\nEvaluation successfully completed.")


if __name__ == "__main__":
    main()
