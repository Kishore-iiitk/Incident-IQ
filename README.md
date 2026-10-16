# IncidentIQ - Autonomous AI Incident-Response System

IncidentIQ is an autonomous incident response platform that detects software incidents, unifies multi-modal evidence (logs, screenshots, audio notes, user reports), evaluates blast radius, deduces probable root cause with cited evidence, routes remediations to responsible engineering teams, and writes comprehensive engineering bug reports and executive summaries.

---

## Architecture Flow

```
┌────────────────┐     ┌──────────────┐     ┌────────────────────────────────────────────────────────┐
│ Evidence Input │ ──> │ Async Queue  │ ──> │ 7-Stage Analysis Pipeline                              │
│ (Text/Logs)    │     │ Ingestion    │     │ 1. Text Processor (Entities, Errors, Timestamps)       │
└────────────────┘     └──────────────┘     │ 2. Fusion (Unified Timeline & Context Bundle)          │
                                            │ 3. RAG Retrieval (Past Incidents - Stub in Phase 1)    │
                                            │ 4. Triage Agent (Severity P1-P4, Blast Radius)         │
                                            │ 5. Root Cause Agent (Strong Model + Evidence Quotes)   │
                                            │ 6. Team Router (Rules matching Teams DB -> LLM)        │
                                            │ 7. Writer Agent (Bug Report, Fixes, Exec Brief)        │
                                            └────────────────────────────────────────────────────────┘
                                                                       │
                                                                       ▼
                                                    ┌──────────────────────────────────────┐
                                                    │ Real-Time UI (React + Socket.IO)     │
                                                    │ Dashboard • Telemetry • Root Cause   │
                                                    └──────────────────────────────────────┘
```

---

## Directory Structure

```
Incident-IQ/
├── client/                     # React 18 + Vite + Tailwind CSS Frontend
│   ├── src/
│   │   ├── components/         # Navbar, SeverityBadge, StatusBadge, StageProgress
│   │   ├── pages/              # Dashboard, Submit, IncidentDetail
│   │   ├── App.jsx             # Top-level state and Socket.IO listener
│   │   ├── index.css           # Styling tokens & glassmorphism theme
│   │   └── main.jsx
├── server/                     # Node.js + Express + Socket.IO + Mongoose
│   ├── agents/
│   │   ├── prompts/            # Stage prompts, PROMPT_VERSION, Zod schemas
│   │   ├── cache/              # Real recorded runs for DEMO_MODE
│   │   └── gemini.js           # GenAI wrapper (JSON enforcement, retry, redaction)
│   ├── db/
│   │   └── connection.js       # MongoDB connection (with automatic in-memory fallback)
│   ├── models/                 # Incidents, Artifacts, Evidence, Analyses, Teams, etc.
│   ├── processors/             # textProcessor, fusion, rag (stub)
│   ├── tests/                  # Automated test suite (Gemini retry, pipeline, API)
│   ├── utils/                  # redactor (PII, tokens, sensitive data scrubber)
│   ├── app.js                  # Express endpoints
│   ├── pipeline.js             # End-to-end 7-stage pipeline & async job queue
│   └── index.js                # Server entrypoint
├── ml/                         # Python FastAPI microservice (embeddings, classifier)
├── demo-lms/                   # Target testbed college LMS
├── eval/                       # Evaluation benchmarks and metrics
├── docs/                       # Architectural documentation
├── reference/
│   └── old-incidentiq/         # Read-only legacy reference prototype
├── .env.example                # Example environment configuration
├── .gitignore
├── package.json
└── README.md
```

---

## Environment Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Available variables:
- `PORT`: Server port (default: `5000`)
- `CLIENT_URL`: Client origin for CORS (default: `http://localhost:5173`)
- `MONGODB_URI`: MongoDB Atlas or local MongoDB connection string. *If omitted, an embedded in-memory MongoDB starts automatically.*
- `GEMINI_API_KEY`: Google Gemini API key.
- `GEMINI_MODEL`: Fast Gemini model (default: `gemini-2.5-flash`).
- `GEMINI_MODEL_STRONG`: High-reasoning model for root-cause analysis (default: `gemini-2.5-pro`).
- `DEMO_MODE`: Set to `true` to serve real recorded outputs from cache with prominent UI badge; `false` to invoke live Gemini APIs.

---

## Running Locally

### 1. Install Dependencies
```bash
# In server directory
cd server
npm install

# In client directory
cd ../client
npm install
```

### 2. Run Test Suite
```bash
cd server
npm test
```
The test suite validates:
1. Gemini wrapper retries once on invalid JSON and succeeds when corrected.
2. Gemini wrapper fails cleanly after 1 retry if output remains invalid.
3. Pipeline transitions incident status to `"failed"` on unhandled stage errors.
4. `POST /incidents` returns immediately with status 202 while placing the job in the async queue.

### 3. Start the Backend Server
```bash
cd server
npm run dev
# Server will listen on http://localhost:5000
```

### 4. Start the Frontend Client
```bash
cd client
npm run dev
# Client will be accessible at http://localhost:5173
```

---

## Phase 1 Gate Verification Incident

Sample benchmark incident:
> *"Students cannot open assignment pages since 2pm, the course page shows a 500 error and the upload button spins forever."*

Submit this incident in the UI via the **Submit Incident** page (or use the one-click **Load Preset** button).
Watch the 7 pipeline stages run in real-time via Socket.IO:
1. **Text Processor**: Extracts entities (`course-service`, `assignment pages`, `upload button`), errors (`500 error`, `spins forever`), and timestamps (`since 2pm`).
2. **Fusion**: Generates unified timeline and context bundle.
3. **RAG Retrieval**: Stub returning `[]` for Phase 1.
4. **Triage Agent**: Classifies as **P2 - Major Impairment** with affected subsystems.
5. **Root Cause Agent**: Deduces probable root cause, cites supporting evidence with exact quotes, and discounts alternative hypotheses.
6. **Router**: Deterministically matches `course-service` / `lms-core` to **Backend** team from the `teams` database.
7. **Writer Agent**: Generates structured bug report with reproduction steps, technical remediation actions, and executive brief.
