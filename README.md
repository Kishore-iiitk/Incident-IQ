# IncidentIQ - Autonomous AI Incident-Response System

IncidentIQ is an autonomous incident response platform that ingests multi-modal telemetry and user reports, deduplicates alerts, unifies cross-modal evidence into a single timeline, computes hybrid severity ratings, deduces probable root causes with strictly cited evidence, routes remediations to owning engineering teams, and writes comprehensive engineering bug reports and executive briefs.

It features a continuous **Human-in-the-Loop (HITL)** audit workflow, a closed-loop **Confirmed Incident Learning Loop** powered by vector embeddings, an automated **telemetry collector network**, and an interactive **college LMS testbed** with live fault injection.

---

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    EVIDENCE INGESTION                                   │
│  ┌──────────────────────┐  ┌───────────────────────┐  ┌──────────────────────────────┐  │
│  │ User Submissions     │  │ Telemetry Collectors  │  │ Multi-Modal Artifacts        │  │
│  │ • Web Form Text      │  │ • Express Middleware  │  │ • Server Logs (.log)         │  │
│  │ • Email Reports      │  │ • HTTP Health Poller  │  │ • UI Screenshots (PNG/JPG)   │  │
│  │ • Complaint Audio    │  │ • Log Stream Watcher  │  │ • Voice Memos (M4A/WAV/MP3)  │  │
│  └──────────┬───────────┘  └───────────┬───────────┘  └──────────────┬───────────────┘  │
└─────────────┼──────────────────────────┼─────────────────────────────┼──────────────────┘
              ▼                          ▼                             ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │                  Deduplication & Fingerprint Engine                    │
   │      (SHA-256 Signature, Time Window Sliding, Signal Count Aggregation) │
   └─────────────────────────────────────┬──────────────────────────────────┘
                                         ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │                   In-Process Asynchronous Job Queue                    │
   └─────────────────────────────────────┬──────────────────────────────────┘
                                         ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │                        7-STAGE ANALYSIS PIPELINE                       │
   │                                                                        │
   │  1. Evidence Processors                                                │
   │     • Log Miner (Template clustering, Drain-like parsing)              │
   │     • Vision Processor (Gemini Vision + Tesseract OCR fallback)        │
   │     • Speech Processor (Gemini Audio transcription + symptom extraction│
   │     • Text & Email Processor (Header stripping, sentiment, impact)     │
   │                                                                        │
   │  2. Cross-Modal Fusion Engine                                          │
   │     • Unified chronological event stream & canonical context bundle    │
   │                                                                        │
   │  3. Vector Knowledge Base RAG Retrieval                                │
   │     • Hybrid vector search (SentenceTransformer embeddings)            │
   │     • Merges static incident runbooks + confirmed resolved incidents   │
   │     • Strict RAG_MIN_SCORE filtering + confirmed past incident boost   │
   │                                                                        │
   │  4. Triage & Hybrid Severity Assessment                                │
   │     • 3-Way consensus: Deterministic Rules + ML Classifier + LLM Triage│
   │     • Degraded fallback mode + discordance flag (needs_review)         │
   │                                                                        │
   │  5. Root Cause Reasoning Agent (High-Reasoning Model)                  │
   │     • Primary hypothesis with strictly verified citations ([EV-xx])    │
   │     • Alternative hypotheses discounted with counter-evidence          │
   │                                                                        │
   │  6. Ownership Team Router                                              │
   │     • Deterministic matching against Service Catalog & Owned Systems   │
   │     • LLM fallback for novel or multi-subsystem boundaries             │
   │                                                                        │
   │  7. Writer & Remediation Agent                                         │
   │     • Engineering bug report, reproduction steps, technical fixes      │
   │     • Non-technical executive summary for stakeholders                 │
   └─────────────────────────────────────┬──────────────────────────────────┘
                                         │
              ┌──────────────────────────┴──────────────────────────┐
              ▼                                                     ▼
┌──────────────────────────────────────┐  ┌──────────────────────────────────────┐
│ Real-Time UI (React 18 + Socket.IO)  │  │ Confirmed Incident Learning Loop     │
│ • Live pipeline stage streaming      │  │ • Human review & audit tracking      │
│ • Evidence timeline & citation links │  │ • Confirmed root cause & fix storage │
│ • HITL approval & editing controls   │  │ • Vector embedding into RAG corpus   │
│ • Incident resolution & retry modals │  │ • In-memory retrieval cache flush    │
└──────────────────────────────────────┘  └──────────────────────────────────────┘
```

---

## Core Capabilities & Latest Features

### 1. Multi-Modal Evidence Ingestion & Parsing
- **Log Processor**: Identifies error levels, status codes, timestamps, and clusters repeated log lines into parameter-free log templates with occurrence counts and time bounds.
- **Vision Processor**: Evaluates error screenshots using Gemini Vision multimodal processing, extracting UI error banners, failed buttons, and visual anomalies with local Tesseract OCR fallback.
- **Speech Processor**: Ingests recorded voice notes and audio memos (`.m4a`, `.mp3`, `.wav`, etc.), transcribes spoken complaints with Gemini Audio, and extracts emotional urgency and impacted workflows.
- **Email & Text Processor**: Normalizes free-form text reports, strips email reply chains and signature footers, identifies affected users, and analyzes sentiment severity.

### 2. Automated Telemetry Collectors
- **Express Error Reporter Middleware**: Automatically captures unhandled HTTP 5xx responses, slow request latencies, and unhandled promise rejections directly from instrumented services (`collectors/errorReporter.js`).
- **HTTP Health Poller**: Periodically probes registered service endpoints (e.g. `demo-lms /health`), detecting downtime, HTTP errors, or latency spikes exceeding threshold limits (`server/collectors/healthPoller.js`).
- **Log Stream Watcher**: Continuously tails application log files on disk (e.g. `demo-lms/logs/app.log`), streaming matching error patterns to the backend (`server/collectors/logWatcher.js`).

### 3. Real-Time Signal Deduplication
- Computes deterministic SHA-256 fingerprints based on service name, endpoint, status code, and sanitized error messages.
- Groups rapid incoming error spikes into a single active incident within a sliding time window, updating affected user counts and signal timestamps instead of creating alert storms.

### 4. Hybrid Severity Assessment Engine
- Blends three independent evaluation signals:
  1. **Deterministic Rule Engine**: Hard constraints (e.g., total database outage or core auth down = P1; slow background job = P3/P4).
  2. **Classical ML Classifier**: FastAPI Python microservice running trained `SentenceTransformer` text embeddings with classification models (Logistic Regression / SVM / Naive Bayes / Random Forest) returning class probability distributions across P1–P4.
  3. **LLM Triage Agent**: Evaluates qualitative blast radius and user impact.
- Combines signals using median consensus and flags incidents with `needs_review = true` whenever multi-level discordance is detected.
- Features graceful degradation when the Python ML service is offline.

### 5. Vector Knowledge Base & Retrieval-Augmented Generation (RAG)
- Generates 384-dimensional vector embeddings for incidents using `all-MiniLM-L6-v2`.
- Matches current symptoms against known runbooks and resolved historical incidents.
- Pre-filters results using a strict raw similarity threshold (`RAG_MIN_SCORE = 0.41`) to prevent hallucinations from irrelevant context.
- Applies ranking boosts (`RAG_CONFIRMED_BOOST = +0.10`) for incidents verified through the human learning loop.

### 6. Citation-Grounding Root Cause Analysis
- Gemini high-reasoning model produces root cause hypotheses with mandatory, verifiable citations.
- Citations must strictly match context bundle IDs (`[EV-01]`, `[EV-02]`, etc.) or retrieved knowledge base IDs (`[CONFIRMED-...]`).
- Invalid or hallucinated citations are stripped and flagged; unreferenced claims trigger visual warnings in the UI.

### 7. Human-in-the-Loop (HITL) Review & Audit Tracking
- Engineers can review, approve, or edit AI-deduced fields (Severity, Assigned Team, Root Cause).
- Changes are tracked in an immutable `reviews` sub-collection recording reviewer identity, previous value, new value, and timestamp.
- Resolving an incident requires confirmed root cause and remediation inputs.

### 8. Confirmed Incident Learning Loop
- When an incident is marked **Resolved**, its confirmed title, symptoms, root cause, and remediation plan are embedded via the ML `/embed` endpoint.
- Persisted to the `confirmed_incidents` database collection and immediately made available to the RAG retrieval engine for future similar incidents.

### 9. Interactive Demo Testbed LMS & Fault Injection
- Bundled full-stack demo application: `demo-lms` simulates a university learning management system.
- One-click and CLI-driven fault injection:
  - `db-down`: Simulates Postgres/database connection drop.
  - `upload-error`: Forces assignment storage failures (500 Internal Server Error).
  - `slow-login`: Injects 4000ms latency into authentication routes.
  - `reset`: Restores system to healthy state.

### 10. Reproducible Evaluation Suite (`eval/`)
- Comprehensive benchmarking harness evaluating:
  - Severity classification accuracy & macro-F1 (`eval_severity.js`).
  - Ownership team routing accuracy (`eval_routing.js`).
  - Vector retrieval recall@K, MRR, and negative query rejection (`eval_retrieval.js`).
  - Multi-source alert deduplication & clustering precision/recall (`eval_dedup.js`).
  - Pipeline latency profiling across stages (`eval_latency.js`).
  - Pipeline ablations (Full vs. RAG-off vs. Fusion-off vs. Text-only) (`eval_ablations.js`).
  - Blind A/B rater test generation (`eval_rag_ab.js`).
  - End-to-end learning loop re-occurrence verification (`scenario4.js`).

---

## Directory Structure

```
Incident-IQ/
├── client/                         # React 18 + Vite + Tailwind CSS Frontend
│   ├── src/
│   │   ├── components/             # Navbar, SeverityBadge, StatusBadge, StageProgress
│   │   ├── pages/
│   │   │   ├── Dashboard.jsx       # Real-time incident list, filters, collector badges
│   │   │   ├── Submit.jsx          # Multimodal upload form (logs, vision, speech, email, text)
│   │   │   └── IncidentDetail.jsx  # Pipeline stage visualizer, timeline fusion, HITL review, citations
│   │   ├── api.js                  # Axios/fetch API client wrapper
│   │   ├── App.jsx                 # Top-level state and Socket.IO real-time telemetry listener
│   │   ├── index.css               # Styling tokens & glassmorphism theme
│   │   └── main.jsx
│   ├── package.json
│   └── vite.config.js
│
├── server/                         # Node.js + Express 5 + Socket.IO Backend
│   ├── agents/
│   │   ├── prompts/                # Zod validation schemas, system prompts, PROMPT_VERSION
│   │   ├── cache/                  # Recorded runs for DEMO_MODE offline playback
│   │   ├── gemini.js               # Google GenAI wrapper (JSON enforcement, retry, fallback, redaction)
│   │   └── severity.js             # 3-Way hybrid severity consensus calculator
│   ├── collectors/                 # Backend telemetry polling & log tailing
│   │   ├── healthPoller.js         # HTTP health endpoint poller
│   │   └── logWatcher.js           # Disk file stream tailer
│   ├── db/
│   │   └── connection.js           # MongoDB connection with automatic in-memory fallback
│   ├── fusion/
│   │   └── timeline.js             # Cross-modal timeline builder and citation validator
│   ├── models/
│   │   └── index.js                # Mongoose models: Incident, Artifact, Evidence, Analysis, Team, Review, ConfirmedIncident
│   ├── processors/                 # Evidence processing engines
│   │   ├── log.js                  # Drain-like log template parser & error extractor
│   │   ├── vision.js               # Gemini Vision + Tesseract OCR fallback
│   │   ├── speech.js               # Gemini Audio speech-to-text transcriber
│   │   ├── text.js                 # Email & complaint normalizer
│   │   ├── textProcessor.js        # Plaintext processor fallback
│   │   ├── fusion.js               # Pipeline fusion runner
│   │   └── rag.js                  # Pipeline RAG retrieval runner
│   ├── rag/
│   │   ├── index.js                # Vector search index loader & scoring
│   │   └── retrieve.js             # RAG retrieval with thresholding and confirmed boost
│   ├── services/
│   │   └── dedup.js                # Alert fingerprinting & deduplication service
│   ├── utils/
│   │   ├── redactor.js             # Sensitive data scrubber (PII, tokens, passwords, keys)
│   │   └── htmlCleaner.js          # HTML tag cleaner & entity decoder
│   ├── tests/                      # 120+ Automated unit and integration tests
│   ├── uploads/                    # Staged multipart file uploads
│   ├── app.js                      # Express routes, file validation, review & resolve endpoints
│   ├── pipeline.js                 # 7-Stage analysis pipeline and async job queue
│   └── index.js                    # Server entrypoint and Socket.IO attachment
│
├── ml/                             # Python FastAPI Machine Learning Microservice
│   ├── data/                       # Kaggle and synthetic incident training datasets
│   ├── models/                     # Serialized models (`best_model.joblib`, metadata)
│   ├── tests/                      # Pytest test suite for ML inference & validation
│   ├── app.py                      # FastAPI endpoints (/health, /embed, /classify)
│   ├── classifier.py               # Scikit-learn multi-class severity classifier
│   ├── train.py                    # Training harness with grid search and cross-validation
│   ├── eval_retrieval.py           # Python vector retrieval benchmark
│   └── requirements.txt            # Python dependencies
│
├── collectors/                     # Client/Agent SDK Collectors
│   └── errorReporter.js            # Express error handler middleware for monitored services
│
├── demo-lms/                       # Target Testbed LMS Service
│   ├── logs/                       # Application output log folder (tailed by logWatcher)
│   ├── app.js                      # LMS Express application with course/upload/auth routes
│   ├── db.js                       # LMS database connection & in-memory store
│   └── index.js                    # Server entrypoint with fault injection endpoints
│
├── eval/                           # Evaluation & Benchmarking Harness
│   ├── results/                    # Auto-generated JSON and Markdown benchmark reports
│   ├── scenarios/                  # Evaluation scenario datasets
│   ├── eval_severity.js            # Hybrid severity benchmark (Accuracy, Macro-F1)
│   ├── eval_routing.js             # Team routing benchmark against catalog ground truth
│   ├── eval_retrieval.js           # Vector search recall@K, MRR, negative score bounds
│   ├── eval_dedup.js               # Multi-source deduplication precision/recall
│   ├── eval_latency.js             # Pipeline stage latency profiling
│   ├── eval_ablations.js           # Full vs. RAG-off vs. Fusion-off vs. Text-only ablation matrix
│   ├── eval_rag_ab.js              # Blind A/B evaluation dataset generator
│   ├── scenario4.js                # End-to-end Learning Loop re-occurrence scenario
│   └── run_all.js                  # One-command runner for entire evaluation suite
│
├── fixtures/                       # Test scenarios & multi-modal evidence fixtures
│   ├── scenario1/                  # DB connection drop scenario (logs, screenshot, audio, emails)
│   └── phase3/                     # Phase 3 evaluation fixtures
│
├── scripts/                        # Operational & Automation CLI Scripts
│   ├── demo-start.js               # One-command launcher for ML, Server, and Demo-LMS
│   ├── fault.js                    # Fault injection CLI tool (db-down, slow-login, etc.)
│   ├── run_scenario.js             # Multipart scenario runner utility
│   └── capture-fixtures.js         # Fixture generation script
│
├── docs/                           # Architecture specifications & verification notes
├── .env.example                    # Comprehensive environment template
├── package.json                    # Workspace root scripts & dependencies
└── README.md                       # System documentation
```

---

## Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|---|---|---|
| `PORT` | Node.js Backend Server port | `5000` |
| `CLIENT_URL` | React client URL for CORS | `http://localhost:5173` |
| `VITE_API_URL` | Backend URL referenced by Vite frontend | `http://localhost:5000` |
| `INCIDENTIQ_URL` | Backend URL for telemetry collectors | `http://localhost:5000/incidents` |
| `MONGODB_URI` | MongoDB connection string. *If omitted, an embedded in-memory MongoDB runs automatically.* | `mongodb://localhost:27017/incidentiq` |
| `GEMINI_API_KEY` | Google Gemini API key | *Required for live AI pipeline* |
| `GEMINI_MODEL` | Fast Gemini model for extraction, triage, and router | `gemini-3.8-flash` |
| `GEMINI_MODEL_STRONG` | High-reasoning model for root cause analysis | `gemini-3.1-pro-preview` |
| `GEMINI_MAX_ATTEMPTS` | Maximum retry attempts for Gemini JSON responses | `4` |
| `GEMINI_FALLBACK_MODEL` | Optional fallback model if primary model is throttled | *(Optional)* |
| `ML_SERVICE_URL` | Python FastAPI ML microservice URL | `http://localhost:8001` |
| `DEMO_MODE` | If `true`, serves recorded pipeline runs offline from cache with a UI badge | `false` |
| `DEMO_LMS_PORT` | Port for the testbed college LMS | `4100` |
| `DEMO_LMS_URL` | Target URL for the testbed LMS | `http://localhost:4100` |
| `DEMO_LMS_LOG_PATH` | Path to Demo-LMS log file for the log watcher collector | `demo-lms/logs/app.log` |
| `FAULT_KEY` | Shared secret header (`X-Fault-Key`) for fault injection | `demo-fault-secret-key` |
| `ENABLE_POLLER` | Enable the automated background health poller | `true` |
| `ENABLE_LOG_WATCHER` | Enable the automated background log stream tailer | `true` |
| `HEALTH_POLL_INTERVAL_MS`| Interval between health checks (ms) | `30000` |
| `SLOW_THRESHOLD_MS` | Latency threshold to flag an endpoint as slow (ms) | `2000` |

---

## Quickstart & Running Locally

### Prerequisites
- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher
- **Python**: v3.10 or higher (for the ML microservice)
- **MongoDB**: Local or MongoDB Atlas *(optional: embedded in-memory MongoDB starts automatically if omitted)*
- **Gemini API Key**: From [Google AI Studio](https://aistudio.google.com/)

---

### Option A: One-Command Full Demo Setup (Recommended)

1. **Install dependencies**:
   ```bash
   # Root & backend dependencies
   npm install
   npm --prefix server install
   npm --prefix client install
   npm --prefix demo-lms install

   # Python ML dependencies (in a virtual environment)
   python -m venv .venv
   # Windows:
   .venv\Scripts\activate
   # Linux/macOS:
   # source .venv/bin/activate
   pip install -r ml/requirements.txt
   ```

2. **Train the ML Severity Model** (takes ~15 seconds):
   ```bash
   python ml/train.py
   ```

3. **Launch the Demo Stack** (Starts ML Service on 8001, Backend Server on 5000 with collectors, and Demo-LMS on 4100):
   ```bash
   npm run demo:start
   ```

4. **Launch the React Frontend** (in a separate terminal):
   ```bash
   npm run dev:client
   ```
   Open [http://localhost:5173](http://localhost:5173) in your browser.

---

### Option B: Running Individual Services Manually

1. **Start the ML Service**:
   ```bash
   python -m uvicorn ml.app:app --port 8001
   ```
2. **Start the Backend Server**:
   ```bash
   npm run dev:server
   ```
3. **Start the Demo LMS Service**:
   ```bash
   node demo-lms/index.js
   ```
4. **Start the Client UI**:
   ```bash
   npm run dev:client
   ```

---

## Fault Injection & Live Demonstration

The included `demo-lms` service supports live fault injection to demonstrate the autonomous detection, deduplication, and resolution cycle:

### 1. Trigger Fault Scenarios via CLI

```bash
# Simulate a database drop (connection pool exhaustion / ECONNREFUSED)
npm run fault:db-down

# Simulate file storage & assignment upload failures
npm run fault:upload-error

# Simulate severe latency degradation on user authentication
npm run fault:slow-login

# Reset all faults back to healthy state
npm run fault:reset
```

### 2. Observe Autonomous Detection in IncidentIQ
1. Watch the **Express Error Reporter**, **Health Poller**, or **Log Watcher** detect the anomaly.
2. In the React UI Dashboard, observe the new incident appear with its telemetry badge (`Poller`, `Reporter`, or `Log Watcher`).
3. Click into the incident to watch the **7-stage pipeline** run in real-time via Socket.IO:
   - Multimodal evidence parsed and placed on the timeline.
   - Vector RAG retrieves relevant runbooks.
   - Hybrid severity engine reconciles rules, ML probabilities, and LLM triage.
   - Root cause is deduced with clickable evidence citations.
   - Remediation tasks are assigned to the responsible team (e.g. `Backend` or `Database`).
4. Click **Approve** or **Edit** to perform human-in-the-loop review.
5. Click **Mark as Resolved** to submit confirmed root cause and fix details, automatically closing the loop and embedding the resolution for future incidents.

---

## Multi-Modal Scenario Submission

Submit a complete multi-modal incident package (logs, screenshots, audio memos, and user emails) with one command:

```bash
# Run Scenario 1 (Database failure with 5 multi-modal evidence files)
npm run scenario -- scenario1
```

Or upload files interactively via the **Submit Incident** page in the web UI.

---

## Evaluation & Benchmarks

Run the complete evaluation suite across all benchmark areas:

```bash
# Run entire evaluation harness
npm run eval:all

# Run individual evaluations
node eval/eval_severity.js     # Severity classification accuracy & macro-F1
node eval/eval_routing.js      # Owning team routing accuracy
node eval/eval_retrieval.js    # Vector search recall@K, MRR, negative query bounds
node eval/eval_dedup.js        # Alert deduplication & grouping precision/recall
node eval/eval_latency.js      # End-to-end pipeline latency profiling
node eval/eval_ablations.js    # Comparative ablation matrix (Full vs RAG-off vs Fusion-off)
node eval/eval_rag_ab.js       # Blind A/B evaluation generator

# Verify the end-to-end Learning Loop re-occurrence scenario
npm run scenario4
```

Benchmark output reports and JSON metrics are automatically generated in `eval/results/`.

---

## Running the Automated Test Suites

### Backend Unit & Integration Tests (120+ tests)
```bash
npm run test:server
# or
cd server && npm test
```
Validates Gemini retries, Zod schema validation, pipeline stage transitions, deduplication sliding windows, health poller probes, log stream tailing, hybrid severity consensus, human review audit tracking, and learning loop vector ranking boosts.

### Python ML Test Suite (40+ tests)
```bash
python -m pytest ml/tests
```
Validates text embedding dimensions, classifier inference, model metadata loading, dataset splitting, rubric scoring, and FastAPI HTTP responses.

### Frontend Production Build
```bash
npm run build:client
```
Verifies Vite build compilation and asset bundling with zero errors.

---

## License

This project is licensed under the MIT License.
