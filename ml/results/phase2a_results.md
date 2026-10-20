# Phase 2a Severity Classifier Evaluation Results

## Summary
- **Best Model by Validation Macro-F1**: `sentence_transformer_logreg`
- **Validation Macro-F1**: 0.5947
- **Validation Accuracy**: 0.5750

## Overall Metrics Comparison

| Model | Val Acc | Val Macro-F1 | T2 (Gemini) Acc | T2 Macro-F1 | T3 (Gold) Acc | T3 Macro-F1 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **majority_baseline** | 0.4250 | 0.1491 | 0.4200 | 0.1479 | 0.3333 | 0.1250 |
| **tfidf_logreg** | 0.6000 | 0.5665 | 0.4900 | 0.4642 | 0.4667 | 0.4221 |
| **sentence_transformer_logreg** | 0.5750 | 0.5947 | 0.4400 | 0.4430 | 0.5333 | 0.5417 |

## Detailed Performance Breakdown by Model

### Model: majority_baseline
#### Validation Set (40 rows)
- **Accuracy**: 0.4250
- **Macro-F1**: 0.1491

| Class | Precision | Recall | F1-Score | Support |
| :--- | :---: | :---: | :---: | :---: |
| P1 | 0.0000 | 0.0000 | 0.0000 | 5 |
| P2 | 0.0000 | 0.0000 | 0.0000 | 9 |
| P3 | 0.4250 | 1.0000 | 0.5965 | 17 |
| P4 | 0.0000 | 0.0000 | 0.0000 | 9 |

Confusion Matrix (Rows: True [P1..P4], Cols: Pred [P1..P4]):
```
True \ Pred    P1    P2    P3    P4
P1            0     0     5     0
P2            0     0     9     0
P3            0     0    17     0
P4            0     0     9     0
```

#### Test T2 - Held-out Gemini (100 rows)
- **Accuracy**: 0.4200
- **Macro-F1**: 0.1479

| Class | Precision | Recall | F1-Score | Support |
| :--- | :---: | :---: | :---: | :---: |
| P1 | 0.0000 | 0.0000 | 0.0000 | 12 |
| P2 | 0.0000 | 0.0000 | 0.0000 | 24 |
| P3 | 0.4200 | 1.0000 | 0.5915 | 42 |
| P4 | 0.0000 | 0.0000 | 0.0000 | 22 |

Confusion Matrix (Rows: True [P1..P4], Cols: Pred [P1..P4]):
```
True \ Pred    P1    P2    P3    P4
P1            0     0    12     0
P2            0     0    24     0
P3            0     0    42     0
P4            0     0    22     0
```

#### Test T3 - Gold Set (15 rows)
- **Accuracy**: 0.3333
- **Macro-F1**: 0.1250

| Class | Precision | Recall | F1-Score | Support |
| :--- | :---: | :---: | :---: | :---: |
| P1 | 0.0000 | 0.0000 | 0.0000 | 5 |
| P2 | 0.0000 | 0.0000 | 0.0000 | 2 |
| P3 | 0.3333 | 1.0000 | 0.5000 | 5 |
| P4 | 0.0000 | 0.0000 | 0.0000 | 3 |

Confusion Matrix (Rows: True [P1..P4], Cols: Pred [P1..P4]):
```
True \ Pred    P1    P2    P3    P4
P1            0     0     5     0
P2            0     0     2     0
P3            0     0     5     0
P4            0     0     3     0
```

### Model: tfidf_logreg
#### Validation Set (40 rows)
- **Accuracy**: 0.6000
- **Macro-F1**: 0.5665

| Class | Precision | Recall | F1-Score | Support |
| :--- | :---: | :---: | :---: | :---: |
| P1 | 0.5714 | 0.8000 | 0.6667 | 5 |
| P2 | 0.5000 | 0.2222 | 0.3077 | 9 |
| P3 | 0.5909 | 0.7647 | 0.6667 | 17 |
| P4 | 0.7143 | 0.5556 | 0.6250 | 9 |

Confusion Matrix (Rows: True [P1..P4], Cols: Pred [P1..P4]):
```
True \ Pred    P1    P2    P3    P4
P1            4     1     0     0
P2            2     2     5     0
P3            1     1    13     2
P4            0     0     4     5
```

#### Test T2 - Held-out Gemini (100 rows)
- **Accuracy**: 0.4900
- **Macro-F1**: 0.4642

| Class | Precision | Recall | F1-Score | Support |
| :--- | :---: | :---: | :---: | :---: |
| P1 | 0.3636 | 0.3333 | 0.3478 | 12 |
| P2 | 0.3929 | 0.4583 | 0.4231 | 24 |
| P3 | 0.5217 | 0.5714 | 0.5455 | 42 |
| P4 | 0.6667 | 0.4545 | 0.5405 | 22 |

Confusion Matrix (Rows: True [P1..P4], Cols: Pred [P1..P4]):
```
True \ Pred    P1    P2    P3    P4
P1            4     5     3     0
P2            5    11     7     1
P3            2    12    24     4
P4            0     0    12    10
```

#### Test T3 - Gold Set (15 rows)
- **Accuracy**: 0.4667
- **Macro-F1**: 0.4221

| Class | Precision | Recall | F1-Score | Support |
| :--- | :---: | :---: | :---: | :---: |
| P1 | 1.0000 | 0.4000 | 0.5714 | 5 |
| P2 | 0.0000 | 0.0000 | 0.0000 | 2 |
| P3 | 0.5000 | 0.6000 | 0.5455 | 5 |
| P4 | 0.5000 | 0.6667 | 0.5714 | 3 |

Confusion Matrix (Rows: True [P1..P4], Cols: Pred [P1..P4]):
```
True \ Pred    P1    P2    P3    P4
P1            2     3     0     0
P2            0     0     2     0
P3            0     0     3     2
P4            0     0     1     2
```

### Model: sentence_transformer_logreg
#### Validation Set (40 rows)
- **Accuracy**: 0.5750
- **Macro-F1**: 0.5947

| Class | Precision | Recall | F1-Score | Support |
| :--- | :---: | :---: | :---: | :---: |
| P1 | 0.7143 | 1.0000 | 0.8333 | 5 |
| P2 | 0.3333 | 0.3333 | 0.3333 | 9 |
| P3 | 0.6429 | 0.5294 | 0.5806 | 17 |
| P4 | 0.6000 | 0.6667 | 0.6316 | 9 |

Confusion Matrix (Rows: True [P1..P4], Cols: Pred [P1..P4]):
```
True \ Pred    P1    P2    P3    P4
P1            5     0     0     0
P2            2     3     3     1
P3            0     5     9     3
P4            0     1     2     6
```

#### Test T2 - Held-out Gemini (100 rows)
- **Accuracy**: 0.4400
- **Macro-F1**: 0.4430

| Class | Precision | Recall | F1-Score | Support |
| :--- | :---: | :---: | :---: | :---: |
| P1 | 0.3571 | 0.8333 | 0.5000 | 12 |
| P2 | 0.2500 | 0.2500 | 0.2500 | 24 |
| P3 | 0.5926 | 0.3810 | 0.4638 | 42 |
| P4 | 0.5714 | 0.5455 | 0.5581 | 22 |

Confusion Matrix (Rows: True [P1..P4], Cols: Pred [P1..P4]):
```
True \ Pred    P1    P2    P3    P4
P1           10     2     0     0
P2           12     6     5     1
P3            6    12    16     8
P4            0     4     6    12
```

#### Test T3 - Gold Set (15 rows)
- **Accuracy**: 0.5333
- **Macro-F1**: 0.5417

| Class | Precision | Recall | F1-Score | Support |
| :--- | :---: | :---: | :---: | :---: |
| P1 | 0.6667 | 0.4000 | 0.5000 | 5 |
| P2 | 0.5000 | 0.5000 | 0.5000 | 2 |
| P3 | 0.4286 | 0.6000 | 0.5000 | 5 |
| P4 | 0.6667 | 0.6667 | 0.6667 | 3 |

Confusion Matrix (Rows: True [P1..P4], Cols: Pred [P1..P4]):
```
True \ Pred    P1    P2    P3    P4
P1            2     1     2     0
P2            0     1     1     0
P3            1     0     3     1
P4            0     0     1     2
```

## Methodological & Honest Note on Sample Sizes and Synthetic Labels

> [!IMPORTANT]
> 1. **Sample Size Limitations**: The Gold Set (T3) contains only 15 curated rows. While valuable as an independent human-vetted anchor, individual misclassifications result in large (~6.7%) swings in accuracy or recall. Metrics on T3 must be interpreted as qualitative directional indicators rather than high-statistical-power benchmarks.
> 2. **Synthetic Rubric Bias**: The training, validation, and T2 datasets (tickets_v3.csv) originate from deterministic synthetic specs derived from an incident rubric. Although generator diversity (ChatGPT, Claude, Gemini) reduces prompt-specific artifacts, models may capture synthetic generation stylistic regularities. Validation macro-F1 was used strictly for model selection, keeping T2 and T3 strictly held-out.
