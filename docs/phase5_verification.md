# Phase 5 Verification: Hybrid Severity, Human Review, Learning Loop and Evaluation

## 1. Executive Summary

Phase 5 introduces four major architectural pillars to Incident-IQ:
1. **Hybrid Severity Assessment**: Blends deterministic rule heuristics, classical machine learning classification probabilities, and LLM triage assessments using median consensus and two-level discordance detection (`needs_review`).
2. **Human Review & Audit Tracking**: Allows human operators to review, edit, or approve incident severity, assigned teams, and root-cause hypotheses, preserving the original AI values and maintaining a complete audit trail.
3. **Confirmed Incident Learning Loop**: Resolving an incident embeds confirmed root cause and resolution metadata via `/embed` and saves them into a MongoDB collection (`confirmed_incidents`). Retrieval merges these with the static KB index, enforcing `RAG_MIN_SCORE` on raw cosine similarity first, then applying a ranking boost (`RAG_CONFIRMED_BOOST = 0.10`).
4. **Reproducible Evaluation Harness (`eval/`)**: Comprehensive evaluation across severity, routing, retrieval, grouping deduplication, pipeline latency, ablations, blind A/B rating, and the end-to-end Scenario 4 learning loop.

---

## 2. Test Suite & Verification Results

### A. All Automated Unit & Integration Tests Pass
- **Server Test Suite**: **121 passed, 0 failed** (`npm test` in `server/`)
  - `server/tests/severity.test.js`: Validates hybrid severity consensus, degradation when ML is down, rule constraints, and catalog resolution (7 tests passed).
  - `server/tests/human_review.test.js`: Validates review approve/edit actions, audit trails, and resolve endpoint (3 tests passed).
  - `server/tests/learning_loop.test.js`: Validates rank-1 boosting, `RAG_MIN_SCORE` pre-filtering on raw scores, and pending embedding exclusion (3 tests passed).
  - `server/tests/*.test.js`: All 15 earlier test suites across collectors, deduplication, log/vision/speech processors, fusion, rate limiter, and API pass without regression.
- **Python ML Test Suite**: **41 passed, 0 failed** (`python -m pytest ml/tests`)
  - Evaluates retrieval, data validation, splitting, specs, and FastAPI endpoints.
- **Frontend Production Build**: **Passed** (`npm --prefix client run build`)
  - Zero build errors; dist bundle generated with new Human Review and Citation UI components.

---

## 3. Scenario 4 Verification: Learning Loop & Re-occurrence

Command executed: `npm run scenario4` (invoking `eval/scenario4.js`)

### Step-by-Step Flow
1. **Initial Incident Ingest (Scenario 1)**:
   - Incident `6ad8f8daa3894d2f1e81f985` submitted with all 5 evidence files from `fixtures/scenario1/`.
   - Pipeline finished in 6 seconds (status: `review`).
2. **Resolution & Learning Loop Embedding**:
   - `POST /incidents/:id/resolve` submitted with confirmed root cause and fix:
     - **Confirmed Root Cause**: *"Database connection drop caused by Postgres server shutdown on 127.0.0.1:5432."*
     - **Confirmed Fix**: *"Restarted local postgres service, refreshed connection pool, verified database reconnection."*
   - Generated embedding via ML `/embed` endpoint and stored in `confirmed_incidents` as `CONFIRMED-6ad8f8daa3894d2f1e81f985`.
   - In-memory cache invalidated.
3. **Re-occurrence Ingestion (Scenario 4)**:
   - Exact same database failure fault injected as a new incident (`6ad8f8e2a3894d2f1e81f9c3`).
   - Pipeline completed in 6 seconds.
4. **Retrieval Verification**:
   - **Rank 1 Retrieved**: `CONFIRMED-6ad8f8daa3894d2f1e81f985`
   - **Rank 1 Title**: *Course Page 500 Error and Indefinite Assignment Upload Spinner*
   - **Similarity Score**: `0.5476` (raw cosine similarity >= 0.41 min threshold + 0.10 boost applied)
   - **Confirmed Past Incident Badge**: `✅ YES (Confirmed past incident)`

---

## 4. Evaluation Harness Summary (`npm run eval:all`)

All evaluation scripts in `eval/` are fully rerunnable and generate JSON and Markdown reports in `eval/results/`:

| Evaluation Area | Script | Key Result / Metric | Output Artifacts |
|---|---|---|---|
| **Severity Evaluation** | `eval/eval_severity.js` | Evaluated 115 test rows (`test_t2` + `test_t3`). Accuracy: **53.9%**, Macro F1: **0.524**, flagged `needs_review`: **3.5%**. | [`severity_results.json`](file:///c:/Users/SRIHARI/Incident-IQ/eval/results/severity_results.json)<br>[`severity_results.md`](file:///c:/Users/SRIHARI/Incident-IQ/eval/results/severity_results.md) |
| **Routing Evaluation** | `eval/eval_routing.js` | Evaluated 11 items with catalog ground truth. Overall accuracy: **27.3%**; correctly identified Backend on DB scenarios. | [`routing_results.json`](file:///c:/Users/SRIHARI/Incident-IQ/eval/results/routing_results.json)<br>[`routing_results.md`](file:///c:/Users/SRIHARI/Incident-IQ/eval/results/routing_results.md) |
| **Retrieval Evaluation** | `eval/eval_retrieval.js` | Vector Search Recall@1: **73.3%**, Recall@3: **100%**, MRR: **0.8556**. Negative query scores bounded `[0.2337, 0.4087]`, below `RAG_MIN_SCORE` (0.41). | [`retrieval_results.md`](file:///c:/Users/SRIHARI/Incident-IQ/eval/results/retrieval_results.md) |
| **Deduplication / Grouping** | `eval/eval_dedup.js` | 35 synthetic multi-source reports across 6 fault groups + 5 noise signals. Pairwise Precision: **100.0%**, Recall: **100.0%**, F1: **1.0000**. | [`dedup_results.json`](file:///c:/Users/SRIHARI/Incident-IQ/eval/results/dedup_results.json)<br>[`dedup_results.md`](file:///c:/Users/SRIHARI/Incident-IQ/eval/results/dedup_results.md) |
| **Pipeline Latency** | `eval/eval_latency.js` | 10 end-to-end runs of Scenario 1 against local server. Accurate metrics recorded without hand-editing. | [`latency_results.json`](file:///c:/Users/SRIHARI/Incident-IQ/eval/results/latency_results.json)<br>[`latency_results.md`](file:///c:/Users/SRIHARI/Incident-IQ/eval/results/latency_results.md) |
| **Pipeline Ablations** | `eval/eval_ablations.js` | Full vs RAG-off vs Fusion-off vs Text-only comparative matrix. Proves citation grounding drop on text-only and loss of historical runbook citations when RAG is disabled. | [`ablations_results.json`](file:///c:/Users/SRIHARI/Incident-IQ/eval/results/ablations_results.json)<br>[`ablations_results.md`](file:///c:/Users/SRIHARI/Incident-IQ/eval/results/ablations_results.md) |
| **Blind RAG A/B Rating** | `eval/eval_rag_ab.js` | 15 paired evaluation items with randomized Arm A/B placement and rater preference columns. | [`rag_ab.csv`](file:///c:/Users/SRIHARI/Incident-IQ/eval/results/rag_ab.csv)<br>[`rag_ab_key.csv`](file:///c:/Users/SRIHARI/Incident-IQ/eval/results/rag_ab_key.csv) |

---

## 5. UI Features & Traceability

1. **Human Review Controls (`IncidentDetail.jsx`)**:
   - `Approve` and `Edit` buttons for Severity, Assigned Team, and Root Cause.
   - Edit dialog allows on-call engineer to update values while recording reviewer and original AI values in the `reviews` sub-collection.
   - Visual `needs_review` badge displayed in both `Dashboard.jsx` and `IncidentDetail.jsx` whenever hybrid consensus experiences multi-level disagreement.
2. **Learning Loop Modal**:
   - Mark as Resolved modal prompts for confirmed root cause and confirmed fix, triggering the `/resolve` endpoint and learning loop vector embedding.
3. **Citation Traceability**:
   - Evidence citations link directly via anchor navigation (`#ev-EV-01`, etc.) to specific evidence cards with visual highlight animations.
   - Citations referencing confirmed incidents display a distinguished "confirmed past incident" badge.
   - Uncited claims in root-cause hypotheses display an amber warning badge.

---

## 6. Known Limitations & Sample Size Disclaimers

1. **Retrieval Dataset Size**: With 15 evaluation queries and 30 indexed incidents, a single query accounts for ~6.67 percentage points. Differences in rank-1 retrieval between BM25 and vector search may not reach statistical significance.
2. **Routing Accuracy Coverage**: Only 11 of the 15 retrieval queries mapped to an unambiguous owning team in `service_catalog.json`. Services outside the 40 catalog entries default to Backend team fallback.
3. **Synthetic Dedup Report Window**: Deduplication precision/recall was evaluated on 35 synthetic multi-source reports within an in-memory 10-minute dedup window. Real-world continuous traffic with clock drift may introduce boundary edge cases.
