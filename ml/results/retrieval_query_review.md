# Retrieval Query Review Document

This document lists each evaluation query alongside the target historical incident in the Knowledge Base (title, service, family, and symptoms).
Two teammates can use this document to confirm by eye that the semantic match is reasonable, realistic, and representative of customer reports and telemetry alerts.

## Summary Table

| Query ID | Expected KB ID | Family | Service | Incident Title | Overlap Run | Flagged (>=4 words)? |
|---|---|---|---|---|---|---|
| Q-01 | KB-001 | `login_failure` | `identity-provider` | Expired SAML Signing Certificate | 4 words (`saml assertion validation failures`) | **FLAGGED** |
| Q-02 | KB-003 | `login_failure` | `redis-cache` | Session Eviction During Login | 3 words (`back to the`) | **OK** |
| Q-03 | KB-005 | `login_failure` | `auth-service` | Password Hash Algorithm Configuration Drift | 1 words (`following`) | **OK** |
| Q-04 | KB-006 | `upload_failure` | `file-upload` | Reverse Proxy Request Body Limit | 3 words (`assignment submission page`) | **OK** |
| Q-05 | KB-008 | `upload_failure` | `file-upload` | Temporary Disk Exhaustion | 2 words (`creation errors`) | **OK** |
| Q-06 | KB-010 | `upload_failure` | `malware-scan-service` | File Scanning Dependency Unavailable | 2 words (`but every`) | **OK** |
| Q-07 | KB-011 | `slow_or_timeout` | `db-primary` | Missing Index on Course Enrollment Query | 2 words (`request latency`) | **OK** |
| Q-08 | KB-013 | `slow_or_timeout` | `redis-cache` | Cache Stampede After Broad Invalidation | 3 words (`course and timetable`) | **OK** |
| Q-09 | KB-015 | `slow_or_timeout` | `course-dashboard` | Synchronous Third-Party Calendar Dependency | 2 words (`calendar api`) | **OK** |
| Q-10 | KB-017 | `grades_issue` | `db-replica` | Stale Gradebook Read Replica | 2 words (`the gradebook`) | **OK** |
| Q-11 | KB-019 | `grades_issue` | `grade-service` | Timezone Boundary Error in Submission Eligibility | 3 words (`from the gradebook`) | **OK** |
| Q-12 | KB-022 | `notification_failure` | `email-service` | SMTP Provider Throttling | 2 words (`smtp rejection`) | **OK** |
| Q-13 | KB-024 | `notification_failure` | `notification-service` | Notification Preferences Changed During Migration | 1 words (`logs`) | **OK** |
| Q-14 | KB-027 | `video_playback` | `video-transcoding` | Unsupported Transcoded Video Codec | 2 words (`but the`) | **OK** |
| Q-15 | KB-029 | `video_playback` | `s3-media-storage` | Video Origin Read Permission Removed | 5 words (`origin fetch failures and storage`) | **FLAGGED** |

---

## Detailed Pairwise Review

### Q-01 &rarr; KB-001: Expired SAML Signing Certificate
- **Family**: `login_failure`
- **Service**: `identity-provider`
- **Longest Shared Word Run**: 4 words (*"saml assertion validation failures"*)
> [!WARNING]
> **Consecutive Word Run Flag**: Shared phrase has 4 consecutive words (*"saml assertion validation failures"*). Reviewers should verify that this domain terminology is natural in real alerts rather than an verbatim leak.

**Query Text:**
> [ALERT] Authentication monitoring reports a sharp spike in SAML assertion validation failures accompanied by a massive drop in successful logins, as users attempting to access their dashboard are redirected to the sign-in page.

**Expected Incident Symptoms:**
> Students enter their credentials and are redirected back to the LMS login screen instead of reaching their dashboard. Authentication monitoring records SAML assertion validation failures, and successful login counts drop sharply.

**Reviewer Confirmation:**
- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.
- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.

---

### Q-02 &rarr; KB-003: Session Eviction During Login
- **Family**: `login_failure`
- **Service**: `redis-cache`
- **Longest Shared Word Run**: 3 words (*"back to the"*)

**Query Text:**
> Subject: Can't stay logged in. Every time I put in my password and get past the main sign-in step, the page just loops right back to the login screen before I can even see my classes!

**Expected Incident Symptoms:**
> Users can submit valid credentials but are sent back to the LMS login page immediately after authentication. Application traces show sessions being created successfully and then disappearing before the first authenticated request completes.

**Reviewer Confirmation:**
- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.
- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.

---

### Q-03 &rarr; KB-005: Password Hash Algorithm Configuration Drift
- **Family**: `login_failure`
- **Service**: `auth-service`
- **Longest Shared Word Run**: 1 words (*"following"*)

**Query Text:**
> Ticket: Following the latest software push, telemetry graphs show an unexpected spike in credential check errors blocking valid users, while rates for nonexistent usernames show no unusual movement.

**Expected Incident Symptoms:**
> Users with previously working accounts submit their credentials but receive an invalid-login message and cannot access the LMS. Authentication metrics show a sudden increase in password verification failures following an application release, without a corresponding rise in unknown usernames.

**Reviewer Confirmation:**
- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.
- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.

---

### Q-04 &rarr; KB-006: Reverse Proxy Request Body Limit
- **Family**: `upload_failure`
- **Service**: `file-upload`
- **Longest Shared Word Run**: 3 words (*"assignment submission page"*)

**Query Text:**
> Hey team, whenever anyone tries turning in their coursework on the assignment submission page, the browser throws an HTTP 413 error and the document never shows up.

**Expected Incident Symptoms:**
> Students select a file on an assignment submission page, but the upload fails and the file does not appear in the submission. Browser requests return an HTTP 413 response for affected uploads, while the upload application records no completed upload operation.

**Reviewer Confirmation:**
- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.
- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.

---

### Q-05 &rarr; KB-008: Temporary Disk Exhaustion
- **Family**: `upload_failure`
- **Service**: `file-upload`
- **Longest Shared Word Run**: 2 words (*"creation errors"*)

**Query Text:**
> [ALERT] Node-level storage telemetry indicates filesystem capacity exhaustion across worker instances handling attachments, generating recurring temporary file creation errors during student uploads.

**Expected Incident Symptoms:**
> Students choose assignment files and see the upload operation fail before the submission is completed. Server logs show temporary-file creation errors, and failed requests cluster on the upload nodes while file sizes remain within the configured limit.

**Reviewer Confirmation:**
- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.
- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.

---

### Q-06 &rarr; KB-010: File Scanning Dependency Unavailable
- **Family**: `upload_failure`
- **Service**: `malware-scan-service`
- **Longest Shared Word Run**: 2 words (*"but every"*)

**Query Text:**
> Hello support team, I've been trying for the last half hour to upload my project file, but every single attempt results in an error message and the document never attaches. Can someone please look into this?

**Expected Incident Symptoms:**
> Students submit assignment files, but every affected upload ends with a submission error and the attachment remains unavailable in the LMS. Upload metrics show requests waiting at the validation stage, while scanner health checks fail and the scanning queue grows.

**Reviewer Confirmation:**
- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.
- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.

---

### Q-07 &rarr; KB-011: Missing Index on Course Enrollment Query
- **Family**: `slow_or_timeout`
- **Service**: `db-primary`
- **Longest Shared Word Run**: 2 words (*"request latency"*)

**Query Text:**
> Issue report: Database performance dashboards display a sharp increase in request latency and prolonged query execution times specifically when fetching course enrollment data for student dashboards.

**Expected Incident Symptoms:**
> Students report that course pages and their dashboards take a long time to open or eventually time out. Application monitoring shows elevated database query durations and increased request latency, especially when loading course enrollment information.

**Reviewer Confirmation:**
- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.
- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.

---

### Q-08 &rarr; KB-013: Cache Stampede After Broad Invalidation
- **Family**: `slow_or_timeout`
- **Service**: `redis-cache`
- **Longest Shared Word Run**: 3 words (*"course and timetable"*)

**Query Text:**
> Is anyone else noticing that course and timetable views are crawling right now, and the database metrics are showing a massive spike in SQL queries alongside a dead cache hit rate?

**Expected Incident Symptoms:**
> Course pages that normally open quickly begin loading slowly, and some requests time out during busy periods. Monitoring shows a sudden drop in cache hit rate accompanied by a large increase in database reads for course and timetable data.

**Reviewer Confirmation:**
- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.
- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.

---

### Q-09 &rarr; KB-015: Synchronous Third-Party Calendar Dependency
- **Family**: `slow_or_timeout`
- **Service**: `course-dashboard`
- **Longest Shared Word Run**: 2 words (*"calendar api"*)

**Query Text:**
> [ALERT] Performance telemetry flags excessive response times on the main student dashboard caused by protracted waiting periods for external calendar API calls.

**Expected Incident Symptoms:**
> Students report that their LMS dashboard loads slowly or fails to finish opening, even though other basic pages remain accessible. Request traces show that dashboard responses spend most of their time waiting for an external academic calendar API, whose latency has increased.

**Reviewer Confirmation:**
- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.
- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.

---

### Q-10 &rarr; KB-017: Stale Gradebook Read Replica
- **Family**: `grades_issue`
- **Service**: `db-replica`
- **Longest Shared Word Run**: 2 words (*"the gradebook"*)

**Query Text:**
> Dear instructor, my professor posted the grades for our quiz yesterday, but when I open the gradebook view in the portal, none of the new scores show up for me. Could my account be out of sync?

**Expected Incident Symptoms:**
> Students see missing or outdated marks in the gradebook shortly after instructors publish or update results. The primary database contains the expected grade records, but requests routed to the read replica return older values.

**Reviewer Confirmation:**
- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.
- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.

---

### Q-11 &rarr; KB-019: Timezone Boundary Error in Submission Eligibility
- **Family**: `grades_issue`
- **Service**: `grade-service`
- **Longest Shared Word Run**: 3 words (*"from the gradebook"*)

**Query Text:**
> Defect ticket: Work uploaded close to the cutoff time is getting excluded from evaluation batches due to incorrect offset comparisons, leaving student records absent from the gradebook.

**Expected Incident Symptoms:**
> Students find that marks for assignments submitted near the deadline are missing from the gradebook or that those submissions show an incorrect grading status. Submission records contain the expected timestamps, but the grading process excludes affected records from its eligible set.

**Reviewer Confirmation:**
- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.
- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.

---

### Q-12 &rarr; KB-022: SMTP Provider Throttling
- **Family**: `notification_failure`
- **Service**: `email-service`
- **Longest Shared Word Run**: 2 words (*"smtp rejection"*)

**Query Text:**
> Hey, notice how email alerts stopped going out to everyone? The outbound message queue is piling up with SMTP rejection notices and nothing is getting delivered.

**Expected Incident Symptoms:**
> Students stop receiving expected LMS email notifications even though the underlying assignment, grade, or account event occurs successfully. Monitoring shows a growing outbound email queue, repeated temporary SMTP rejection responses, and messages that remain pending delivery.

**Reviewer Confirmation:**
- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.
- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.

---

### Q-13 &rarr; KB-024: Notification Preferences Changed During Migration
- **Family**: `notification_failure`
- **Service**: `notification-service`
- **Longest Shared Word Run**: 1 words (*"logs"*)

**Query Text:**
> [ALERT] Messaging logs indicate that dispatch routines are suppressing all course alerts due to failing preference validations across student profiles following the recent system migration.

**Expected Incident Symptoms:**
> Students no longer receive email notifications for course announcements and assignment updates, even though their accounts remain active and related LMS events are generated normally. Notification audit logs show that messages were suppressed by preference checks rather than rejected by the mail provider.

**Reviewer Confirmation:**
- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.
- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.

---

### Q-14 &rarr; KB-027: Unsupported Transcoded Video Codec
- **Family**: `video_playback`
- **Service**: `video-transcoding`
- **Longest Shared Word Run**: 2 words (*"but the"*)

**Query Text:**
> Hi IT helpdesk, I am trying to watch today's recorded lecture video for my computer science class, but the player keeps throwing a decoding error and refuses to play anything even though the page loads fine. Please help!

**Expected Incident Symptoms:**
> Students can open a lecture page, but the embedded video will not begin playing and the player reports a media decoding error. Monitoring shows that the video assets are reachable and the streaming requests return successful HTTP responses, yet browser playback fails.

**Reviewer Confirmation:**
- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.
- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.

---

### Q-15 &rarr; KB-029: Video Origin Read Permission Removed
- **Family**: `video_playback`
- **Service**: `s3-media-storage`
- **Longest Shared Word Run**: 5 words (*"origin fetch failures and storage"*)
> [!WARNING]
> **Consecutive Word Run Flag**: Shared phrase has 5 consecutive words (*"origin fetch failures and storage"*). Reviewers should verify that this domain terminology is natural in real alerts rather than an verbatim leak.

**Query Text:**
> Incident report: Edge delivery monitoring registers persistent origin fetch failures and storage permission denials when viewers attempt to load recorded lecture media through the CDN.

**Expected Incident Symptoms:**
> Students open lecture pages, but the video player fails to load the requested media and displays a playback error. CDN logs show origin fetch failures and storage access-denied responses for lecture objects that were previously available.

**Reviewer Confirmation:**
- [ ] **Reviewer 1 (SRE / Platform)**: The incident symptoms describe this exact failure pattern.
- [ ] **Reviewer 2 (QA / Support)**: The phrasing reflects realistic student or alert language.

---
