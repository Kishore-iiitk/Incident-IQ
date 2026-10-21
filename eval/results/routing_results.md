# IncidentIQ Routing Evaluation Report

## Summary Metrics

- **Evaluated Items**: 11
- **Skipped Items (unknown team)**: 8
- **Correctly Routed**: 3
- **Routing Accuracy**: **27.3%**

## Detailed Routing Results

| Item ID | Description | Expected Team | Routed Team | Status | Result |
|---|---|---|---|---|---|
| scenario1 | Scenario 1: Database Outage | Backend | Backend | evaluated | ✅ PASS |
| scenario2 | Scenario 2: Upload Service Failure | File Service | Backend | evaluated | ❌ FAIL |
| scenario3 | Scenario 3: Slow Login / Auth Delay | Auth | Backend | evaluated | ❌ FAIL |
| scenario4 | Scenario 4: Re-occurrence with Learning Loop | Backend | Backend | evaluated | ✅ PASS |
| Q-01 | [ALERT] Authentication monitoring reports a sharp spike in S... | N/A | N/A | skipped | ⚠️ SKIPPED |
| Q-02 | Subject: Can't stay logged in. Every time I put in my passwo... | Database | Backend | evaluated | ❌ FAIL |
| Q-03 | Ticket: Following the latest software push, telemetry graphs... | N/A | N/A | skipped | ⚠️ SKIPPED |
| Q-04 | Hey team, whenever anyone tries turning in their coursework ... | File Service | Backend | evaluated | ❌ FAIL |
| Q-05 | [ALERT] Node-level storage telemetry indicates filesystem ca... | File Service | Backend | evaluated | ❌ FAIL |
| Q-06 | Hello support team, I've been trying for the last half hour ... | N/A | N/A | skipped | ⚠️ SKIPPED |
| Q-07 | Issue report: Database performance dashboards display a shar... | Database | Backend | evaluated | ❌ FAIL |
| Q-08 | Is anyone else noticing that course and timetable views are ... | Database | Backend | evaluated | ❌ FAIL |
| Q-09 | [ALERT] Performance telemetry flags excessive response times... | N/A | N/A | skipped | ⚠️ SKIPPED |
| Q-10 | Dear instructor, my professor posted the grades for our quiz... | N/A | N/A | skipped | ⚠️ SKIPPED |
| Q-11 | Defect ticket: Work uploaded close to the cutoff time is get... | Backend | Backend | evaluated | ✅ PASS |
| Q-12 | Hey, notice how email alerts stopped going out to everyone? ... | N/A | N/A | skipped | ⚠️ SKIPPED |
| Q-13 | [ALERT] Messaging logs indicate that dispatch routines are s... | N/A | N/A | skipped | ⚠️ SKIPPED |
| Q-14 | Hi IT helpdesk, I am trying to watch today's recorded lectur... | N/A | N/A | skipped | ⚠️ SKIPPED |
| Q-15 | Incident report: Edge delivery monitoring registers persiste... | File Service | Backend | evaluated | ❌ FAIL |

---
> [!NOTE]
> **Sample Size & Limitations**: 15 retrieval queries map to service catalog owning teams via their expected KB incident service. Items where owning team is unknown or ambiguous are skipped. Total evaluated: 11.
