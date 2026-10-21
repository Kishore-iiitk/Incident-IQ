# Phase 2c Retrieval Evaluation Report

> [!NOTE]
> **Sample Size & Statistical Significance**: With 15 queries and 30 incidents, 1 query corresponds to ~6.67 percentage points. Differences between methods may not be statistically significant.

## 1. Overall Metrics: BM25 vs Vector Search

| Metric | BM25 | Vector Search (`all-MiniLM-L6-v2`) | Difference (Vector - BM25) |
|---|---|---|---|
| **Recall@1** | 0.8000 (80.0%) | 0.7333 (73.3%) | -6.7% |
| **Recall@3** | 0.9333 (93.3%) | 1.0000 (100.0%) | +6.7% |
| **Recall@5** | 0.9333 (93.3%) | 1.0000 (100.0%) | +6.7% |
| **MRR** | 0.8727 | 0.8556 | -0.0172 |
| **Sibling Confusion Rate** | 0.2000 (20.0%) | 0.2667 (26.7%) | +6.7% |
| **Cross-Family Error Rate** | 0.0000 (0.0%) | 0.0000 (0.0%) | +0.0% |

## 2. Per-Family Breakdown

| Family | Queries | BM25 Recall@1 | BM25 Recall@3 | Vector Recall@1 | Vector Recall@3 | Vector Sibling Conf | Vector Cross-Fam Err |
|---|---|---|---|---|---|---|---|
| `grades_issue` | 2 | 0.50 | 0.50 | 1.00 | 1.00 | 0.00 | 0.00 |
| `login_failure` | 3 | 1.00 | 1.00 | 0.33 | 1.00 | 0.67 | 0.00 |
| `notification_failure` | 2 | 1.00 | 1.00 | 1.00 | 1.00 | 0.00 | 0.00 |
| `slow_or_timeout` | 3 | 1.00 | 1.00 | 0.67 | 1.00 | 0.33 | 0.00 |
| `upload_failure` | 3 | 0.67 | 1.00 | 0.67 | 1.00 | 0.33 | 0.00 |
| `video_playback` | 2 | 0.50 | 1.00 | 1.00 | 1.00 | 0.00 | 0.00 |

## 3. Score Threshold & Negative Query Analysis

- **Real Query Top-1 Score Range**: `[0.4139, 0.7305]`
- **Negative Query Top-1 Score Range**: `[0.2337, 0.4087]`
- **Overlap Between Ranges**: NO (strictly separated)
- **Recommended `RAG_MIN_SCORE`**: `0.41`

### Negative Query Breakdown

| Query ID | Category | Negative Query Text | Top-1 Nearest Incident | Top-1 Cosine Score | Threshold Decision |
|---|---|---|---|---|---|
| NEG-01 | `classroom_av_hardware` | "The ceiling projector in lecture hall 302 won't power on and the HDMI wall port has a bent pin." | KB-029 (Video Origin Read Permission Removed) | **0.3167** | Dropped (< 0.41) |
| NEG-02 | `campus_parking_services` | "How do I renew my semester campus parking permit and register a second vehicle license plate?" | KB-030 (Digital Rights License Endpoint Unavailable) | **0.2337** | Dropped (< 0.41) |
| NEG-03 | `library_catalogue_search` | "The library online catalogue system returns zero results when searching for physical reserve textbooks by ISBN number." | KB-017 (Stale Gradebook Read Replica) | **0.4087** | Dropped (< 0.41) |
| NEG-04 | `hostel_network_credentials` | "I forgot my dorm room ethernet portal password and the hostel wifi WPA2 Enterprise login is rejecting my credentials." | KB-002 (Authentication Token Rejected Due to Clock Drift) | **0.3926** | Dropped (< 0.41) |
| NEG-05 | `lab_printer_hardware` | "The shared laser printer in the second-floor computer lab has a jammed paper tray and three dozen print jobs stuck in the queue." | KB-010 (File Scanning Dependency Unavailable) | **0.2913** | Dropped (< 0.41) |

## 4. Per-Query Retrieval Details

| Query ID | Target KB | Family | BM25 Top-1 (Score) | BM25 Correct? | Vector Top-1 (Score) | Vector Correct? |
|---|---|---|---|---|---|---|
| Q-01 | `KB-001` | `login_failure` | KB-001 (30.83) | PASS | KB-001 (0.6774) | PASS |
| Q-02 | `KB-003` | `login_failure` | KB-003 (15.49) | PASS | KB-002 (0.4139) | FAIL (KB-002) |
| Q-03 | `KB-005` | `login_failure` | KB-005 (12.85) | PASS | KB-004 (0.5412) | FAIL (KB-004) |
| Q-04 | `KB-006` | `upload_failure` | KB-006 (18.61) | PASS | KB-006 (0.5981) | PASS |
| Q-05 | `KB-008` | `upload_failure` | KB-008 (12.28) | PASS | KB-008 (0.7142) | PASS |
| Q-06 | `KB-010` | `upload_failure` | KB-006 (11.13) | FAIL (KB-006) | KB-007 (0.5277) | FAIL (KB-007) |
| Q-07 | `KB-011` | `slow_or_timeout` | KB-011 (27.98) | PASS | KB-011 (0.7305) | PASS |
| Q-08 | `KB-013` | `slow_or_timeout` | KB-013 (20.92) | PASS | KB-011 (0.6165) | FAIL (KB-011) |
| Q-09 | `KB-015` | `slow_or_timeout` | KB-015 (15.88) | PASS | KB-015 (0.5919) | PASS |
| Q-10 | `KB-017` | `grades_issue` | KB-018 (12.09) | FAIL (KB-018) | KB-017 (0.5853) | PASS |
| Q-11 | `KB-019` | `grades_issue` | KB-019 (12.72) | PASS | KB-019 (0.6017) | PASS |
| Q-12 | `KB-022` | `notification_failure` | KB-022 (15.66) | PASS | KB-022 (0.5941) | PASS |
| Q-13 | `KB-024` | `notification_failure` | KB-024 (10.25) | PASS | KB-024 (0.6420) | PASS |
| Q-14 | `KB-027` | `video_playback` | KB-026 (16.23) | FAIL (KB-026) | KB-027 (0.7254) | PASS |
| Q-15 | `KB-029` | `video_playback` | KB-029 (26.07) | PASS | KB-029 (0.6168) | PASS |

### Error Analysis for Failed Queries

#### Q-02 (Expected `KB-003` - Session Eviction During Login)
- **Query**: "Subject: Can't stay logged in. Every time I put in my password and get past the main sign-in step, the page just loops right back to the login screen before I can even see my classes!"
- **Vector Failure (Sibling Confusion (same family))**: Top-1 returned `KB-002` (Authentication Token Rejected Due to Clock Drift) with score 0.4139 vs expected `KB-003` at rank 2.

#### Q-03 (Expected `KB-005` - Password Hash Algorithm Configuration Drift)
- **Query**: "Ticket: Following the latest software push, telemetry graphs show an unexpected spike in credential check errors blocking valid users, while rates for nonexistent usernames show no unusual movement."
- **Vector Failure (Sibling Confusion (same family))**: Top-1 returned `KB-004` (Exhausted Database Connections) with score 0.5412 vs expected `KB-005` at rank 3.

#### Q-06 (Expected `KB-010` - File Scanning Dependency Unavailable)
- **Query**: "Hello support team, I've been trying for the last half hour to upload my project file, but every single attempt results in an error message and the document never attaches. Can someone please look into this?"
- **BM25 Failure**: Top-1 returned `KB-006` (Reverse Proxy Request Body Limit) with score 11.13.
- **Vector Failure (Sibling Confusion (same family))**: Top-1 returned `KB-007` (Expired Object Storage Credentials) with score 0.5277 vs expected `KB-010` at rank 2.

#### Q-08 (Expected `KB-013` - Cache Stampede After Broad Invalidation)
- **Query**: "Is anyone else noticing that course and timetable views are crawling right now, and the database metrics are showing a massive spike in SQL queries alongside a dead cache hit rate?"
- **Vector Failure (Sibling Confusion (same family))**: Top-1 returned `KB-011` (Missing Index on Course Enrollment Query) with score 0.6165 vs expected `KB-013` at rank 2.

#### Q-10 (Expected `KB-017` - Stale Gradebook Read Replica)
- **Query**: "Dear instructor, my professor posted the grades for our quiz yesterday, but when I open the gradebook view in the portal, none of the new scores show up for me. Could my account be out of sync?"
- **BM25 Failure**: Top-1 returned `KB-018` (Incorrect Assessment Weight Configuration) with score 12.09.

#### Q-14 (Expected `KB-027` - Unsupported Transcoded Video Codec)
- **Query**: "Hi IT helpdesk, I am trying to watch today's recorded lecture video for my computer science class, but the player keeps throwing a decoding error and refuses to play anything even though the page loads fine. Please help!"
- **BM25 Failure**: Top-1 returned `KB-026` (Invalid Signed Video URL) with score 16.23.
