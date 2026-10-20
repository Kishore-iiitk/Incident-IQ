# IncidentIQ Dataset & Rubric Design Specification

## 1. Overview & Objective

Phase 2 introduces the formal severity scoring rubric, service catalog, and synthetic ticket generation pipeline for training and evaluating IncidentIQ's triage classifiers.

To ensure models learn real underlying operational facts rather than superficial linguistic shortcuts, all labels are derived deterministically from a 4-dimensional operational facts rubric rather than arbitrary LLM prompting. Furthermore, synthetic ticket descriptions are generated without label leakage using a strict banned-word filter and deduplication threshold.

---

## 2. Severity Priority Rubric (Plain Language)

Incident priority is mapped into four distinct operational severity tiers:

* **P1 Critical**: A core (tier-1) service is down or badly broken for all or most users, or important data is lost or corrupted, with no workaround.
* **P2 High**: A core service is degraded or partly unavailable for many users, or an important (tier-2) service is fully down; the workaround is partial or costly.
* **P3 Medium**: A limited feature is impaired or a small group is affected; a reasonable workaround exists.
* **P4 Low**: Cosmetic, single-user or internal-convenience issue with negligible impact.

---

## 3. Deterministic Point Matrix

The function `label_from_facts(tier, scope, data_loss, workaround)` calculates the total severity points:

$$\text{Total Points} = \text{Tier Points} + \text{Scope Points} + \text{Data Loss Points} + \text{Workaround Points}$$

### Dimension Point Mapping

| Dimension | Value | Points | Operational Meaning |
| :--- | :--- | :--- | :--- |
| **Service Tier** | `1` | **3** | Core mission-critical service (e.g. auth-sso, exam-portal, payments, lms-web) |
| | `2` | **2** | Important business service (e.g. grade-service, file-upload, search) |
| | `3` | **1** | Ancillary or internal service (e.g. theme-service, alumni-directory, report-export) |
| **Blast Radius (Scope)** | `all` | **3** | Site-wide or 100% of active users affected |
| | `many` | **2** | Substantial population / multiple departments or cohorts affected |
| | `few` | **1** | Isolated group, single course section, or specific edge tenant |
| | `single` | **0** | Individual user or single node/workstation |
| **Data Loss** | `true` | **2** | Persistent data corruption, dropped transactions, or unrecoverable loss |
| | `false` | **0** | Transient compute failure, read error, or retried transaction |
| **Workaround** | `none` | **2** | No bypass or alternate path exists; users completely blocked |
| | `partial` | **1** | Degraded workaround available (e.g. manual CLI export, slow fallback UI) |
| | `easy` | **0** | Trivial workaround (e.g. refresh browser, use alternate link) |

### Score Thresholds

* **Total $\ge$ 8 points**: **P1**
* **Total 6 – 7 points**: **P2**
* **Total 3 – 5 points**: **P3**
* **Total $\le$ 2 points**: **P4**

Theoretical range is **1 to 10 points**.

---

## 4. Banned-Word List (Anti-Leakage Filter)

To prevent target leakage where models simply pick up on explicit priority labels or emergency rhetoric, ticket generation and ingestion enforce a strict banned-word filter. Any candidate ticket containing any of the following terms (case-insensitive) is rejected:

1. `critical`
2. `urgent`
3. `severe`
4. `severity`
5. `sev1`
6. `sev2`
7. `p1`
8. `p2`
9. `p3`
10. `p4`
11. `priority`
12. `emergency`
13. `high priority`
14. `low priority`
15. `blocker`
16. `showstopper`

Candidate tickets must describe symptoms, system behaviors, user impacts, and error traces without using shortcut escalation adjectives.

---

## 5. Dataset Plan

1. **Target Volume**: 800 synthetic specs distributed across 16 batches (50 specs/batch: `ticket_batch_01.json` through `ticket_batch_16.json`).
2. **Target Label Distribution**:
   * **P1**: 12% (96 tickets)
   * **P2**: 24% (192 tickets)
   * **P3**: 42% (336 tickets)
   * **P4**: 22% (176 tickets)
   * *Exact batch stratification*: Every batch contains exactly 6 P1, 12 P2, 21 P3, and 11 P4 specs.
3. **Borderline Representation**:
   * Boundary 7 vs 8 (P2 vs P1 threshold)
   * Boundary 5 vs 6 (P3 vs P2 threshold)
   * Boundary 2 vs 3 (P4 vs P3 threshold)
4. **Style Distribution**:
   * `monitoring_alert`: Structured system telemetry, error code rates, threshold breaches.
   * `user_email`: End-user non-technical perspective describing workflow frustration.
   * `engineer_ticket`: DevOps/SRE issue description with stack traces or endpoint names.
   * `chat_message`: Informal Slack/Teams escalation fragment.
5. **Length Variation**:
   * `short`: Brief 1-2 sentence report.
   * `medium`: Detailed multi-sentence report with context.
6. **Vagueness Sampling**:
   * ~15% of specs have `vague: true` (lacks explicit error details, ambiguous impact, or incomplete description), challenging the classifier to handle real-world messy inputs.
7. **Quality Gates & Ingestion Filter**:
   * Reject missing required fields (`spec_id`, `title`, `description`).
   * Reject unknown `spec_id`.
   * Reject any ticket containing banned words.
   * Reject ticket descriptions shorter than 8 words.
   * Reject near-duplicates with TF-IDF unigram/bigram cosine similarity $> 0.90$ across or within generators.

---

## 6. Dataset Split Plan

When training begins in subsequent phases, the evaluation strategy uses a multi-tier test split to rigorously assess both in-distribution performance and cross-generator generalization:

* **T2 Test Set (Cross-Generator Evaluation)**: All rows generated by one specific generator are held out entirely and never seen during training or validation. This evaluates whether the model generalizes across distinct LLM writing styles, vocabularies, and syntactic patterns.
* **Train / Validation / T1 (In-Distribution Test)**: The remaining candidate rows from other generators are partitioned using a stratified 70/15/15 split:
  * **Train Set (70%)**: Used for fitting model weights and feature representations.
  * **Validation Set (15%)**: Used for hyperparameter tuning, model checkpointing, and threshold calibration.
  * **T1 Test Set (15%)**: In-distribution test set drawn from the same generator distribution as the training data.
* **T3 Test Set (Hand-Written Gold Set)**: An independent, hand-crafted gold benchmark set curated by human engineers with unambiguous ground-truth facts. T3 is strictly reserved for final testing and benchmark evaluation.

### Split Guarantees:
* **Stratified Sampling**: The 70/15/15 split preserves the priority label ratios (`P1`, `P2`, `P3`, `P4`) and balances service categories.
* **Leakage Prevention**: Generator separation between Train/T1 and T2 guarantees that stylistic artifacts from the held-out generator do not leak into training.
* **Test Set Freeze**: All test sets (T1, T2, T3) are immutable and evaluated only once per final candidate architecture.

---

## 7. Known Limitations

1. **Synthetic Generation**: LLM-generated incident descriptions lack some of the idiosyncratic noise, organizational jargon, and multi-threaded confusion of real production incidents.
2. **Rubric-Derived Ground Truth**: Ground truth labels reflect the rubric's deterministic rules rather than post-incident retrospectives or multi-stakeholder consensus.
3. **Domain Bias**: The service catalog is tailored to college LMS, payment gateway, and campus infrastructure environments; generalization to other industrial domains (e.g. embedded IoT, medical devices) requires domain adaptation.
