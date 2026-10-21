# Deduplication Grouping Evaluation Report

## 1. Pairwise Grouping Metrics

| Metric | Value | Description |
|---|---|---|
| **Pairwise Precision** | **100.0%** | Fraction of report pairs clustered together that truly belong to the same incident |
| **Pairwise Recall** | **100.0%** | Fraction of report pairs belonging to the same incident that were grouped together |
| **Pairwise F1** | **1.0000** | Harmonic mean of clustering precision and recall |
| **True Positives (TP)** | 60 | Correctly grouped report pairs |
| **False Positives (FP)** | 0 | Erroneously grouped report pairs (over-merging) |
| **False Negatives (FN)** | 0 | Missed group linkages (under-merging) |
| **True Negatives (TN)** | 535 | Correctly separated report pairs |

## 2. Cluster Formation Summary

- **Total Ingested Reports**: 35
- **Distinct Incident Clusters Formed**: 11

| Fingerprint | Member Count | Report IDs |
|---|---|---|
| `61018fc96fdbbc3e` | 5 | G1_R1, G1_R2, G1_R3, G1_R4, G1_R5 |
| `8a1a79e45d4edb0c` | 5 | G2_R1, G2_R2, G2_R3, G2_R4, G2_R5 |
| `90808aab3789f7e4` | 5 | G3_R1, G3_R2, G3_R3, G3_R4, G3_R5 |
| `52d77de9019a879d` | 5 | G4_R1, G4_R2, G4_R3, G4_R4, G4_R5 |
| `3c17686b115cd836` | 5 | G5_R1, G5_R2, G5_R3, G5_R4, G5_R5 |
| `e5aa348f0f6a35cc` | 5 | G6_R1, G6_R2, G6_R3, G6_R4, G6_R5 |
| `d9c35ac3ad57e987` | 1 | NOISE_1 |
| `17967060929e0c04` | 1 | NOISE_2 |
| `462edd81d1613dda` | 1 | NOISE_3 |
| `e8b85e1ebcd86a0a` | 1 | NOISE_4 |
| `1fa38877320220aa` | 1 | NOISE_5 |

---
> [!NOTE]
> **Sample Size & Limitations**: Evaluated on 35 synthetic multi-source reports (6 true fault groups across poller/reporter/log_watcher plus 5 noise signals) within an in-memory window.
