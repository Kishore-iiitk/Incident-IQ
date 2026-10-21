import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTimeline,
  deduplicateTimeline,
  buildContextBundle,
  validateCitations,
  withinWindow
} from '../fusion/timeline.js';

describe('Timeline Fusion & Citation Validation Unit Tests', () => {
  test('withinWindow accurately detects timestamps within threshold', () => {
    const t1 = '2026-10-21T10:00:00.000Z';
    const t2 = '2026-10-21T10:00:30.000Z';
    const t3 = '2026-10-21T10:05:00.000Z';

    assert.equal(withinWindow(t1, t2, 60000), true);
    assert.equal(withinWindow(t1, t3, 60000), false);
    assert.equal(withinWindow(null, t2), false);
  });

  test('buildTimeline sorts events chronologically and omits skipped evidence', () => {
    const evidenceRecords = [
      {
        id: 'EV-03',
        source: 'audio',
        type: 'audio',
        summary: 'Voice complaint about login failure',
        timestamps: ['2026-10-21T10:02:00.000Z'],
        status: 'ok',
        confidence: 0.8
      },
      {
        id: 'EV-01',
        source: 'log_file',
        type: 'log',
        summary: 'Database connection pool exhausted',
        timestamps: ['2026-10-21T10:00:00.000Z'],
        status: 'ok',
        confidence: 0.95
      },
      {
        id: 'EV-02',
        source: 'screenshot',
        type: 'image',
        summary: 'Skipped screenshot',
        timestamps: [],
        status: 'skipped',
        reason: 'No screenshot provided'
      }
    ];

    const timeline = buildTimeline(evidenceRecords);

    // Should only have 2 events (EV-02 skipped)
    assert.equal(timeline.length, 2);
    // EV-01 (10:00) should be before EV-03 (10:02)
    assert.equal(timeline[0].evidence_id, 'EV-01');
    assert.equal(timeline[1].evidence_id, 'EV-03');
  });

  test('deduplicateTimeline merges duplicate signals with same time window and entity', () => {
    const rawTimeline = [
      {
        timestamp: '2026-10-21T10:00:00.000Z',
        parsed: new Date('2026-10-21T10:00:00.000Z'),
        event: 'Service db connection failed',
        evidence_id: 'EV-01',
        errors: ['ECONNREFUSED'],
        entities: ['database', 'auth-service'],
        confidence: 0.8
      },
      {
        timestamp: '2026-10-21T10:00:20.000Z',
        parsed: new Date('2026-10-21T10:00:20.000Z'),
        event: 'Auth service reporting DB timeout',
        evidence_id: 'EV-02',
        errors: ['ETIMEDOUT'],
        entities: ['auth-service'],
        confidence: 0.9
      },
      {
        timestamp: '2026-10-21T10:15:00.000Z',
        parsed: new Date('2026-10-21T10:15:00.000Z'),
        event: 'Billing service webhook error',
        evidence_id: 'EV-03',
        errors: ['HTTP 500'],
        entities: ['billing'],
        confidence: 0.7
      }
    ];

    const deduped = deduplicateTimeline(rawTimeline, 60000);

    // EV-01 and EV-02 should be merged because they are 20s apart and share 'auth-service'
    assert.equal(deduped.length, 2);

    const merged = deduped[0];
    assert.equal(merged.merged_count, 2);
    assert.deepEqual(merged.merged_from, ['EV-01', 'EV-02']);
    assert.ok(merged.errors.includes('ECONNREFUSED'));
    assert.ok(merged.errors.includes('ETIMEDOUT'));
    assert.equal(merged.confidence, 0.9); // max confidence

    // Third event remains separate
    assert.equal(deduped[1].evidence_id, 'EV-03');
  });

  test('buildContextBundle packages evidence, top templates, entities, and RAG incidents', () => {
    const evidenceRecords = [
      {
        id: 'EV-01',
        source: 'log_file',
        type: 'log',
        summary: 'Log analysis: MongoServerError',
        entities: ['mongodb', 'grades-api'],
        errors: ['MongoServerError'],
        timestamps: ['2026-10-21T10:00:00.000Z'],
        status: 'ok',
        confidence: 0.9,
        templates: [
          { template: 'MongoServerError: connection refused', count: 42, level: 'ERROR' },
          { template: 'GET /api/courses 500', count: 18, level: 'ERROR' }
        ]
      },
      {
        id: 'EV-02',
        source: 'email',
        type: 'text',
        summary: 'Student unable to view assignments',
        entities: ['grades-api'],
        errors: ['HTTP 500'],
        timestamps: [],
        status: 'ok',
        confidence: 0.6
      },
      {
        id: 'EV-03',
        source: 'screenshot',
        type: 'image',
        summary: 'Vision failed: OCR timeout',
        entities: [],
        errors: [],
        timestamps: [],
        status: 'failed',
        reason: 'Image corrupted'
      }
    ];

    const retrievedIncidents = [
      {
        id: 'KB-1042',
        title: 'MongoDB primary node failover',
        service: 'Database',
        family: 'infra_database',
        symptoms: ['connection refused', '500 on all endpoints'],
        root_cause: 'Replica set stepdown during network partition',
        resolution: 'Restarted mongo primary and flushed connection pool',
        score: 0.89
      }
    ];

    const bundle = buildContextBundle({
      evidenceRecords,
      retrievedIncidents,
      incidentTitle: 'LMS Outage',
      incidentDescription: 'System returning 500s',
      incidentId: 'INC-101'
    });

    assert.equal(bundle.incident_id, 'INC-101');
    assert.equal(bundle.user_reports_count, 1);
    assert.equal(bundle.failed_processors.length, 1);
    assert.equal(bundle.failed_processors[0].id, 'EV-03');
    assert.equal(bundle.failed_processors[0].reason, 'Image corrupted');

    assert.ok(bundle.top_error_templates.length >= 2);
    assert.equal(bundle.top_error_templates[0].count, 42);

    assert.ok(bundle.entities.includes('mongodb'));
    assert.ok(bundle.entities.includes('grades-api'));

    assert.equal(bundle.retrieved_incidents.length, 1);
    assert.equal(bundle.retrieved_incidents[0].kb_id, 'KB-1042');
  });

  test('validateCitations marks valid citations as cited and invalid ones as uncited', () => {
    const contextBundle = {
      evidence: [
        { id: 'EV-01', source: 'log' },
        { id: 'EV-02', source: 'email' }
      ],
      retrieved_incidents: [
        { kb_id: 'KB-99' }
      ],
      timeline: [
        { evidence_id: 'EV-01' },
        { evidence_id: 'EV-02' }
      ]
    };

    const rawRootCause = {
      probable_root_cause: 'Database connection pool exhausted due to unindexed queries',
      confidence: 0.85,
      confidence_rationale: 'Logs show repeated MongoServerError and connection pool timeout errors',
      supporting_evidence: [
        {
          quote: 'MongoServerError: connection refused',
          evidence_id: 'EV-01'
        },
        {
          quote: 'Past incident KB-99 experienced identical symptoms',
          evidence_id: 'KB-99'
        },
        {
          quote: 'Phantom evidence that does not exist in bundle',
          evidence_id: 'EV-FAKE-999'
        },
        {
          quote: 'Direct observation without citation'
        }
      ],
      contradicting_evidence: [],
      alternative_hypotheses: [
        {
          hypothesis: 'Network partition between app and DB',
          likelihood: 'low',
          reason_discounted: 'Ping checks responded normally'
        }
      ],
      recommended_next_checks: [
        'Check MongoDB replica set status',
        'Review maxPoolSize setting in db/connection.js'
      ]
    };

    const validated = validateCitations(rawRootCause, contextBundle);

    // EV-01 should be kept and marked 'cited'
    assert.equal(validated.supporting_evidence[0].evidence_id, 'EV-01');
    assert.equal(validated.supporting_evidence[0].status, 'cited');

    // KB-99 should be kept and marked 'cited'
    assert.equal(validated.supporting_evidence[1].evidence_id, 'KB-99');
    assert.equal(validated.supporting_evidence[1].status, 'cited');

    // EV-FAKE-999 must be stripped to null and marked 'uncited'
    assert.equal(validated.supporting_evidence[2].evidence_id, null);
    assert.equal(validated.supporting_evidence[2].status, 'uncited');

    // Item without evidence_id should be null and 'uncited'
    assert.equal(validated.supporting_evidence[3].evidence_id, null);
    assert.equal(validated.supporting_evidence[3].status, 'uncited');
  });
});
