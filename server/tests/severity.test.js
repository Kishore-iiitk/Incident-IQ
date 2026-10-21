import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRulesSeverity,
  combineSeverityComponents,
  computeHybridSeverity,
  pToNumber,
  numberToP,
  resolveCatalogService,
  extractScopePointsFromText
} from '../agents/severity.js';

test('Hybrid Severity Suite', async (t) => {
  await t.test('Rules engine never accesses spec fields (tier, scope, data_loss, workaround)', () => {
    // Pass a fake object that throws if prohibited keys are accessed
    const badTicket = new Proxy(
      {
        title: 'Primary database timeout',
        description: 'Encountered connection drop across the entire campus',
        serviceName: 'db-primary'
      },
      {
        get(target, prop) {
          if (['tier', 'scope', 'data_loss', 'workaround'].includes(prop)) {
            throw new Error(`Prohibited property accessed: ${prop}`);
          }
          return target[prop];
        }
      }
    );

    const result = computeRulesSeverity({
      serviceName: badTicket.serviceName,
      text: `${badTicket.title} ${badTicket.description}`
    });

    assert.ok(result.severity);
    assert.equal(result.level, 1); // tier-1 (db-primary) + "entire campus" (all) -> P1
  });

  await t.test('Agreement among all 3 components produces unanimous result and high confidence', async () => {
    const combined = combineSeverityComponents({
      rulesLevel: 2,
      classifierLevel: 2,
      llmLevel: 2,
      isClassifierDegraded: false
    });

    assert.equal(combined.severity, 'P2');
    assert.equal(combined.level, 2);
    assert.equal(combined.needs_review, false);
    assert.ok(combined.confidence >= 0.8);
    assert.deepEqual(combined.degraded, []);
  });

  await t.test('Two components round toward the MORE severe (lower numeric value)', () => {
    // 2 and 3 -> 2 (P2)
    const resA = combineSeverityComponents({
      rulesLevel: 3,
      classifierLevel: 2,
      llmLevel: null
    });
    assert.equal(resA.severity, 'P2');

    // 1 and 2 -> 1 (P1)
    const resB = combineSeverityComponents({
      rulesLevel: 2,
      classifierLevel: 1,
      llmLevel: null
    });
    assert.equal(resB.severity, 'P1');
  });

  await t.test('Two-level disagreement lowers confidence and sets needs_review = true', () => {
    // P1 and P3 difference is |1 - 3| = 2 levels
    const res = combineSeverityComponents({
      rulesLevel: 1,
      classifierLevel: 3,
      llmLevel: 2
    });

    assert.equal(res.needs_review, true);
    assert.ok(res.confidence < 0.8);
    assert.equal(res.severity, 'P2'); // median of 1, 2, 3 is 2
  });

  await t.test('ML down degrades correctly to rules + LLM, sets degraded flag and keeps working', async () => {
    const res = await computeHybridSeverity({
      title: 'Course materials 404',
      description: 'Multiple users reporting 404 on course materials',
      serviceName: 'course-service',
      triageSeverity: 'P2',
      mockClassifier: null // simulate classifier down
    });

    assert.ok(res.severity);
    assert.deepEqual(res.degraded, ['classifier_unavailable']);
    assert.equal(res.components.classifier, null);
    assert.ok(res.components.rules);
    assert.equal(res.components.llm, 'P2');
  });

  await t.test('Catalog resolution correctly maps demo-lms endpoints and names', () => {
    const sso = resolveCatalogService('/login');
    assert.equal(sso?.name, 'auth-sso');
    assert.equal(sso?.tier, 1);

    const upload = resolveCatalogService('/upload');
    assert.equal(upload?.name, 'file-upload');
    assert.equal(upload?.tier, 2);

    const lms = resolveCatalogService('demo-lms');
    assert.equal(lms?.name, 'lms-web');
    assert.equal(lms?.tier, 1);
  });

  await t.test('Regex scope extraction detects scope words accurately', () => {
    assert.equal(extractScopePointsFromText('Nobody across the entire campus can login'), 3);
    assert.equal(extractScopePointsFromText('Multiple users encounter 500 errors'), 2);
    assert.equal(extractScopePointsFromText('A small group of us cannot submit'), 1);
    assert.equal(extractScopePointsFromText('My account throws error, only me affected'), 0);
  });
});
