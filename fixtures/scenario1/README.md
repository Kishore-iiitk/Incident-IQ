# Scenario 1 Fixtures

This directory contains evidence fixtures for Scenario 1: LMS Outage due to Database Connection Failure.

## Evidence Inventory & Provenance
- `demo_lms.log`: **Real captured log**. Captured from the running `demo-lms` service during a real database connection failure fault injection (`POST /fault/db-down`). Contains 51 lines of HTTP 500 errors across `/courses`, `/upload`, and `/login`.
- `email1.txt`: **Synthetic fixture**. Simulated student complaint email authored as a test fixture, containing standard RFC email headers (`Date`, `From`, `Subject`), greeting, outage symptom description, and signature.
- `email2.txt`: **Synthetic fixture**. Simulated faculty complaint email authored as a test fixture, reporting database connection pool failure across `/courses` and `/upload`.
- `screenshot.png`: **Missing owner-supplied media**. Real browser screenshot of the LMS failure UI, to be captured by the project owner. The pipeline handles this file's absence gracefully (status: `skipped`).
- `voice.m4a`: **Missing owner-supplied media**. Real voice note audio recording reporting the outage, to be recorded by the project owner. The pipeline handles this file's absence gracefully (status: `skipped`).
