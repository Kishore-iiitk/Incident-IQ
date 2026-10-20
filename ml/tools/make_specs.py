#!/usr/bin/env python3
"""Generate synthetic ticket specifications for IncidentIQ.

Writes ml/data/specs/ticket_batch_01.json ... ticket_batch_16.json.
50 specs per batch, 800 specs in total.
Ensures P1 12% (96), P2 24% (192), P3 42% (336), P4 22% (176) of 800.
Enforces 20 specs per service, 15% vague, coherent facts (data_loss only for holds_user_data services),
and strict banned-word validation.
Stratified per batch: each of the 16 batches has the exact same label mix (6 P1, 12 P2, 21 P3, 11 P4).
The specs do NOT contain the priority label.
"""

import json
import os
import random
import re
import sys
from collections import Counter, defaultdict

# Ensure repository root is on sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from ml.rubric import compute_points, label_from_facts

BANNED_WORDS = [
    "critical",
    "urgent",
    "severe",
    "severity",
    "sev1",
    "sev2",
    "p1",
    "p2",
    "p3",
    "p4",
    "priority",
    "emergency",
    "high priority",
    "low priority",
    "blocker",
    "showstopper",
]

_escaped = [re.escape(w).replace(r"\ ", r"\s+") for w in sorted(BANNED_WORDS, key=len, reverse=True)]
BANNED_REGEX = re.compile(r"\b(" + "|".join(_escaped) + r")\b", re.IGNORECASE)

DOMAIN_HINTS = {
    "auth-sso": "Single Sign-On authentication, SAML assertions, and identity provider handshakes",
    "lms-web": "Core student/instructor dashboard, course shell views, and navigation menus",
    "exam-portal": "Timed assessments, automated question delivery, and lockdown proctoring session",
    "course-service": "Course syllabus, module listings, lecture schedules, and roster management",
    "payments": "Tuition fee checkout, credit card processor, and bursar payment ledger",
    "db-primary": "Primary transactional PostgreSQL database cluster handling ACID writes",
    "session-store": "Distributed Redis cache storing active authenticated user sessions",
    "api-gateway": "Edge reverse proxy, TLS termination, and API routing tier",
    "user-directory": "Central LDAP directory storing faculty, staff, and student profile records",
    "db-replica-sync": "WAL streaming replication service between primary and read-replicas",
    "grade-service": "Assignment gradebook calculation, rubric weighting, and letter grade posting",
    "file-upload": "Multipart asset uploader handling lab files, PDFs, and slide decks",
    "assignment-service": "Homework submission workflows, late penalty rules, and turn-in receipts",
    "notifications": "Push notification, SMS dispatcher, and real-time banner alerts",
    "search": "Elasticsearch cluster indexing course syllabi, library resources, and forum posts",
    "enrollment-service": "Semester course registration, waitlist ordering, and prerequisite checks",
    "s3-media-storage": "Cloud object storage bucket hosting recorded lectures and large student videos",
    "discussion-forum": "Course Q&A message boards, thread replies, and pinned announcements",
    "redis-cache": "In-memory cache for course catalogs, class metadata, and fast lookups",
    "quiz-evaluator": "Automated scoring engine for multiple-choice and short-answer quizzes",
    "attendance-tracker": "Classroom attendance logging via campus Wi-Fi check-in and QR codes",
    "cdn-edge": "Content delivery edge nodes caching static JavaScript, CSS, and media",
    "live-classroom-stream": "WebRTC live streaming and screen sharing service for hybrid lectures",
    "rbac-policy-engine": "Role-based access authorization engine for student, TA, and instructor roles",
    "report-export": "Administrative background batch PDF and CSV report generation",
    "theme-service": "Accessibility high-contrast modes, CSS themes, and dark mode toggles",
    "alumni-portal": "Alumni relations portal, directory search, and donation campaign pages",
    "campus-store-catalog": "University bookstore online inventory, textbook lists, and merchandise",
    "survey-service": "End-of-semester course evaluation surveys and student feedback forms",
    "audit-log-exporter": "Security compliance SIEM exporter and audit trail archiver",
    "student-profile-avatar": "Student profile photo resizing, cropping, and thumbnail generator",
    "banner-announcements": "System-wide maintenance notices and announcement banners",
    "transcript-pdf-generator": "Official registrar transcript generation with cryptographic signature",
    "helpdesk-ticketing": "IT campus helpdesk ticket ingestion and support inquiry tracker",
    "library-catalog-sync": "Integration bridge to library catalog and electronic journal reserves",
    "parking-pass-manager": "Campus parking decal registration and citation appeal management",
    "event-calendar": "Campus-wide academic calendar, lecture series, and holiday feeds",
    "feedback-collector": "In-app bug reporting widget and UI experience sentiment collector",
    "db-backup-archiver": "Automated nightly database snapshots and cold archival uploader",
    "email-digest-worker": "Nightly cron worker compiling unread notification summaries",
}

STYLES = ["monitoring_alert", "user_email", "engineer_ticket", "chat_message"]
LENGTHS = ["short", "medium"]


def validate_spec(spec, catalog_lookup):
    """Validate that spec contains no banned words and respects holds_user_data."""
    spec_id = spec.get("spec_id", "UNKNOWN")

    # 1. Check every string in the spec for banned words
    for key, val in spec.items():
        if isinstance(val, str):
            matches = BANNED_REGEX.findall(val)
            if matches:
                raise ValueError(
                    f"Spec '{spec_id}' field '{key}' contains banned word(s): {', '.join(matches)}"
                )

    # 2. Check coherent facts: data_loss = True only when holds_user_data = True
    service_name = spec.get("service")
    service_info = catalog_lookup.get(service_name)
    if not service_info:
        raise ValueError(f"Spec '{spec_id}' references unknown service '{service_name}'.")

    if spec.get("data_loss") is True and not service_info.get("holds_user_data", False):
        raise ValueError(
            f"Spec '{spec_id}' has data_loss=True for service '{service_name}' which does not hold user data."
        )


def load_services(catalog_path):
    with open(catalog_path, "r", encoding="utf-8") as f:
        services = json.load(f)
    catalog_lookup = {s["name"]: s for s in services}
    return services, catalog_lookup


def build_fact_combinations():
    """Index all 72 possible fact combinations by (tier, data_loss, label)."""
    combos_by_tier_dl_lbl = defaultdict(list)
    for tier in [1, 2, 3]:
        for dl in [False, True]:
            for scope in ["all", "many", "few", "single"]:
                for wa in ["none", "partial", "easy"]:
                    pt = compute_points(tier, scope, dl, wa)
                    lbl = label_from_facts(tier, scope, dl, wa)
                    combos_by_tier_dl_lbl[(tier, dl, lbl)].append({
                        "tier": tier,
                        "scope": scope,
                        "data_loss": dl,
                        "workaround": wa,
                        "points": pt,
                        "label": lbl
                    })
    return combos_by_tier_dl_lbl


def generate_all_specs(catalog_path="ml/data/service_catalog.json", seed=42):
    random.seed(seed)
    services, catalog_lookup = load_services(catalog_path)
    combos = build_fact_combinations()

    # Pre-split services
    t1_hud = [s["name"] for s in services if s["tier"] == 1 and s["holds_user_data"]]
    t1_non = [s["name"] for s in services if s["tier"] == 1 and not s["holds_user_data"]]

    t2_hud = [s["name"] for s in services if s["tier"] == 2 and s["holds_user_data"]]
    t2_non = [s["name"] for s in services if s["tier"] == 2 and not s["holds_user_data"]]

    t3_hud = [s["name"] for s in services if s["tier"] == 3 and s["holds_user_data"]]
    t3_non = [s["name"] for s in services if s["tier"] == 3 and not s["holds_user_data"]]

    # Collect exactly 20 specs per service (800 specs total)
    # Target label mix: P1 12% (96), P2 24% (192), P3 42% (336), P4 22% (176)
    # Tier breakdown:
    # T1 (200 specs): 64 P1, 74 P2, 62 P3, 0 P4
    # T2 (280 specs): 32 P1, 88 P2, 124 P3, 36 P4
    # T3 (320 specs): 0 P1, 30 P2, 150 P3, 140 P4
    all_raw_specs = []

    # --- T1: 10 services (2 HUD, 8 non-HUD) -> 200 specs ---
    for s in services:
        if s["tier"] == 1:
            s_combos = []
            if s["holds_user_data"]:
                p1_true = combos[(1, True, "P1")]
                p1_ten = [c for c in p1_true if c["points"] == 10]
                p1_rest = [c for c in p1_true if c["points"] < 10]
                s_combos.append(p1_ten[0] if p1_ten else random.choice(p1_true))
                s_combos.extend([random.choice(p1_rest) for _ in range(4)])
                s_combos.extend([random.choice(combos[(1, False, "P1")]) for _ in range(3)])
                s_combos.extend([random.choice(combos[(1, True, "P2")]) for _ in range(4)])
                s_combos.extend([random.choice(combos[(1, False, "P2")]) for _ in range(3)])
                s_combos.extend([random.choice(combos[(1, True, "P3")]) for _ in range(2)])
                s_combos.extend([random.choice(combos[(1, False, "P3")]) for _ in range(3)])
            else:
                idx = t1_non.index(s["name"])
                n_p1 = 6
                n_p2 = 8 if idx < 4 else 7
                n_p3 = 6 if idx < 4 else 7
                s_combos.extend([random.choice(combos[(1, False, "P1")]) for _ in range(n_p1)])
                s_combos.extend([random.choice(combos[(1, False, "P2")]) for _ in range(n_p2)])
                s_combos.extend([random.choice(combos[(1, False, "P3")]) for _ in range(n_p3)])
            for c in s_combos:
                all_raw_specs.append({"service": s["name"], "tier": 1, **c})

    # --- T2: 14 services (7 HUD, 7 non-HUD) -> 280 specs ---
    for s in services:
        if s["tier"] == 2:
            s_combos = []
            if s["holds_user_data"]:
                idx = t2_hud.index(s["name"])
                n_p1 = 5 if idx < 4 else 4
                n_p2_t, n_p2_f = (4, 3) if idx in [4, 5] else (3, 3)
                n_p3_t, n_p3_f = (4, 4)
                n_p4 = 2 if idx == 6 else 1
                s_combos.extend([random.choice(combos[(2, True, "P1")]) for _ in range(n_p1)])
                s_combos.extend([random.choice(combos[(2, True, "P2")]) for _ in range(n_p2_t)])
                s_combos.extend([random.choice(combos[(2, False, "P2")]) for _ in range(n_p2_f)])
                s_combos.extend([random.choice(combos[(2, True, "P3")]) for _ in range(n_p3_t)])
                s_combos.extend([random.choice(combos[(2, False, "P3")]) for _ in range(n_p3_f)])
                s_combos.extend([random.choice(combos[(2, False, "P4")]) for _ in range(n_p4)])
            else:
                idx = t2_non.index(s["name"])
                n_p2 = 7 if idx < 2 else 6
                n_p3 = 9 if idx < 2 else 10
                n_p4 = 4
                s_combos.extend([random.choice(combos[(2, False, "P2")]) for _ in range(n_p2)])
                s_combos.extend([random.choice(combos[(2, False, "P3")]) for _ in range(n_p3)])
                s_combos.extend([random.choice(combos[(2, False, "P4")]) for _ in range(n_p4)])
            for c in s_combos:
                all_raw_specs.append({"service": s["name"], "tier": 2, **c})

    # --- T3: 16 services (1 HUD, 15 non-HUD) -> 320 specs ---
    for s in services:
        if s["tier"] == 3:
            s_combos = []
            if s["holds_user_data"]:
                s_combos.extend([random.choice(combos[(3, True, "P2")]) for _ in range(6)])
                s_combos.extend([random.choice(combos[(3, True, "P3")]) for _ in range(4)])
                s_combos.extend([random.choice(combos[(3, False, "P3")]) for _ in range(4)])
                s_combos.extend([random.choice(combos[(3, False, "P4")]) for _ in range(6)])
            else:
                idx = t3_non.index(s["name"])
                if idx < 7:
                    n_p2, n_p3, n_p4 = 2, 9, 9
                elif idx < 9:
                    n_p2, n_p3, n_p4 = 2, 10, 8
                elif idx < 14:
                    n_p2, n_p3, n_p4 = 1, 10, 9
                else:
                    n_p2, n_p3, n_p4 = 1, 9, 10
                s_combos.extend([random.choice(combos[(3, False, "P2")]) for _ in range(n_p2)])
                s_combos.extend([random.choice(combos[(3, False, "P3")]) for _ in range(n_p3)])
                s_combos.extend([random.choice(combos[(3, False, "P4")]) for _ in range(n_p4)])
            for c in s_combos:
                all_raw_specs.append({"service": s["name"], "tier": 3, **c})

    # Group by label to stratify into 16 batches
    specs_by_label = defaultdict(list)
    for sp in all_raw_specs:
        specs_by_label[sp["label"]].append(sp)

    for lbl in specs_by_label:
        random.shuffle(specs_by_label[lbl])

    # Stratify per batch: exactly 6 P1, 12 P2, 21 P3, 11 P4 per batch
    # 6*16 = 96 P1, 12*16 = 192 P2, 21*16 = 336 P3, 11*16 = 176 P4 (Total 50 per batch)
    batches_raw = [[] for _ in range(16)]
    for b in range(16):
        batches_raw[b].extend(specs_by_label["P1"][b * 6 : (b + 1) * 6])
        batches_raw[b].extend(specs_by_label["P2"][b * 12 : (b + 1) * 12])
        batches_raw[b].extend(specs_by_label["P3"][b * 21 : (b + 1) * 21])
        batches_raw[b].extend(specs_by_label["P4"][b * 11 : (b + 1) * 11])

    global_id = 1
    batches = []
    for b_idx, batch_items in enumerate(batches_raw):
        random.shuffle(batch_items)
        # Vague distribution: exactly 120 vague specs across 16 batches (8 batches with 8, 8 batches with 7)
        n_vague = 8 if b_idx % 2 == 0 else 7
        vague_indices = set(random.sample(range(len(batch_items)), n_vague))

        batch_specs = []
        for local_idx, item in enumerate(batch_items):
            spec_id = f"SPEC-{global_id:04d}"
            service_name = item["service"]
            domain_hint = DOMAIN_HINTS.get(service_name, f"{service_name} operational service")
            is_vague = local_idx in vague_indices
            style = random.choice(STYLES)
            length = random.choice(LENGTHS)

            spec = {
                "spec_id": spec_id,
                "service": service_name,
                "domain_hint": domain_hint,
                "tier": item["tier"],
                "scope": item["scope"],
                "data_loss": item["data_loss"],
                "workaround": item["workaround"],
                "style": style,
                "length": length,
                "vague": is_vague
            }

            # Enforce validation: no banned words & coherent facts
            validate_spec(spec, catalog_lookup)

            batch_specs.append(spec)
            global_id += 1

        batches.append(batch_specs)

    return batches


def write_spec_batches(output_dir="ml/data/specs", catalog_path="ml/data/service_catalog.json"):
    os.makedirs(output_dir, exist_ok=True)
    all_batches = generate_all_specs(catalog_path=catalog_path, seed=42)

    total_specs = 0
    label_counts = Counter()
    points_counts = Counter()
    style_counts = Counter()
    length_counts = Counter()
    service_counts = Counter()
    data_loss_count = 0
    vague_count = 0
    tier_label_crosstab = defaultdict(Counter)
    batch_p1_counts = []

    for idx, batch in enumerate(all_batches, start=1):
        filename = os.path.join(output_dir, f"ticket_batch_{idx:02d}.json")
        with open(filename, "w", encoding="utf-8") as f:
            json.dump(batch, f, indent=2)

        batch_p1 = 0
        for s in batch:
            total_specs += 1
            pt = compute_points(s["tier"], s["scope"], s["data_loss"], s["workaround"])
            lbl = label_from_facts(s["tier"], s["scope"], s["data_loss"], s["workaround"])
            label_counts[lbl] += 1
            points_counts[pt] += 1
            style_counts[s["style"]] += 1
            length_counts[s["length"]] += 1
            service_counts[s["service"]] += 1
            tier_label_crosstab[s["tier"]][lbl] += 1
            if lbl == "P1":
                batch_p1 += 1
            if s["data_loss"]:
                data_loss_count += 1
            if s["vague"]:
                vague_count += 1
        batch_p1_counts.append(batch_p1)

    print(f"Generated {total_specs} specs across {len(all_batches)} batches in {output_dir}")
    print("\n1. Label distribution:")
    for lbl in ["P1", "P2", "P3", "P4"]:
        cnt = label_counts[lbl]
        pct = (cnt / total_specs) * 100
        print(f"  {lbl}: {cnt} ({pct:.1f}%)")

    print("\n2. Histogram of rubric points (1-10):")
    for pt in range(1, 11):
        cnt = points_counts[pt]
        bar = "#" * (cnt // 2)
        print(f"  Point {pt:2d}: {cnt:3d} ({cnt/total_specs*100:4.1f}%) {bar}")

    print("\n3. Style distribution:")
    for st, cnt in sorted(style_counts.items()):
        print(f"  {st}: {cnt} ({cnt/total_specs*100:.1f}%)")

    print("\n4. Length distribution:")
    for ln, cnt in sorted(length_counts.items()):
        print(f"  {ln}: {cnt} ({cnt/total_specs*100:.1f}%)")

    print("\n5. Specs per service:")
    print(f"  Min: {min(service_counts.values())}, Max: {max(service_counts.values())}")

    print("\n6. Data loss share:")
    print(f"  data_loss = True: {data_loss_count} ({data_loss_count/total_specs*100:.1f}%)")
    print(f"  data_loss = False: {total_specs - data_loss_count} ({(total_specs - data_loss_count)/total_specs*100:.1f}%)")

    print("\n7. Vague specs:")
    print(f"  vague = True: {vague_count} ({vague_count/total_specs*100:.1f}%)")

    print("\n8. Tier x Label cross-tab:")
    print("  Tier |   P1 |   P2 |   P3 |   P4 | Total")
    print("  -----+------+------+------+------+------")
    for tier in [1, 2, 3]:
        p1 = tier_label_crosstab[tier]["P1"]
        p2 = tier_label_crosstab[tier]["P2"]
        p3 = tier_label_crosstab[tier]["P3"]
        p4 = tier_label_crosstab[tier]["P4"]
        t_tot = p1 + p2 + p3 + p4
        print(f"     {tier} | {p1:4d} | {p2:4d} | {p3:4d} | {p4:4d} | {t_tot:5d}")

    print("\n9. P1 count per batch (1 to 16):")
    for idx, cnt in enumerate(batch_p1_counts, start=1):
        print(f"  Batch {idx:02d}: {cnt} P1")


if __name__ == "__main__":
    write_spec_batches()
