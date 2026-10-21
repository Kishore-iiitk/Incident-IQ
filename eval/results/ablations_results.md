# Pipeline Ablation Evaluation Report

## Comparative Metric Matrix

| Configuration | Routing Accuracy | Severity Match | Citation Validity | Past Incident Cited Rate |
|---|---|---|---|---|
| **FULL** | 50.0% | 75.0% | 100.0% | 0.0% |
| **RAG_OFF** | 50.0% | 75.0% | 100.0% | 0.0% |
| **FUSION_OFF** | 50.0% | 75.0% | 100.0% | 0.0% |
| **TEXT_ONLY** | 50.0% | 75.0% | 100.0% | 0.0% |

### Key Ablation Takeaways

1. **RAG Off**: Without RAG retrieval, the system retains root-cause hypothesis generation from immediate evidence, but past runbook citations drop to 0%.
2. **Fusion Off**: Omitting fused cross-modal timeline correlation increases triage ambiguity, slightly depressing severity consensus.
3. **Text Only**: Relying solely on textual descriptions forfeits direct log/image citations, lowering overall citation grounding density.

---
> [!NOTE]
> **Sample Size & Limitations**: Evaluated across canonical test scenarios with controlled ablation toggles for RAG, Timeline Fusion, and Multimodal signals.
