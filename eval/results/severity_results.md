# Severity Evaluation Report

## 1. Overall Performance

| Method | Accuracy | Macro F1 | P1 F1 | P2 F1 | P3 F1 | P4 F1 |
|---|---|---|---|---|---|---|
| **RULES** | 53.9% | 0.524 | 0.429 | 0.379 | 0.552 | 0.737 |
| **CLASSIFIER** | 41.7% | 0.334 | 0.417 | 0.061 | 0.525 | 0.333 |
| **LLM** | 53.9% | 0.524 | 0.429 | 0.379 | 0.552 | 0.737 |
| **HYBRID** | 53.9% | 0.524 | 0.429 | 0.379 | 0.552 | 0.737 |

- **Total tickets evaluated**: 115 (test_t2: 100, test_t3: 15)
- **Incidents flagged with `needs_review: true`**: 4 (3.5%)

## 2. Confusion Matrices

### RULES Confusion Matrix

| Actual \ Pred | P1 | P2 | P3 | P4 |
|---|---|---|---|---|
| **P1** | 6 | 9 | 2 | 0 |
| **P2** | 5 | 11 | 10 | 0 |
| **P3** | 0 | 12 | 24 | 11 |
| **P4** | 0 | 0 | 4 | 21 |

### CLASSIFIER Confusion Matrix

| Actual \ Pred | P1 | P2 | P3 | P4 |
|---|---|---|---|---|
| **P1** | 5 | 1 | 11 | 0 |
| **P2** | 1 | 1 | 24 | 0 |
| **P3** | 1 | 5 | 36 | 5 |
| **P4** | 0 | 0 | 19 | 6 |

### LLM Confusion Matrix

| Actual \ Pred | P1 | P2 | P3 | P4 |
|---|---|---|---|---|
| **P1** | 6 | 9 | 2 | 0 |
| **P2** | 5 | 11 | 10 | 0 |
| **P3** | 0 | 12 | 24 | 11 |
| **P4** | 0 | 0 | 4 | 21 |

### HYBRID Confusion Matrix

| Actual \ Pred | P1 | P2 | P3 | P4 |
|---|---|---|---|---|
| **P1** | 6 | 9 | 2 | 0 |
| **P2** | 5 | 11 | 10 | 0 |
| **P3** | 0 | 12 | 24 | 11 |
| **P4** | 0 | 0 | 4 | 21 |

## 3. Scenario Evaluation

| Scenario | Expected | Rules | ML | Hybrid | Match? |
|---|---|---|---|---|---|
| Scenario 1: Database Outage | P1 | P2 | P1 | P1 | ✅ YES |
| Scenario 2: Upload Service Failure | P2 | P2 | P3 | P2 | ✅ YES |
| Scenario 3: Slow Login / Auth Delay | P3 | P2 | P2 | P2 | ❌ NO |
| Scenario 4: Re-occurrence with Learning Loop | P1 | P2 | P1 | P1 | ✅ YES |

---
> [!NOTE]
> **Sample Size & Limitations**: Tickets lack real-time logs and error telemetry, so affected_users and error_rate were skipped for test_t2/test_t3. Sample size: 115 tickets.
