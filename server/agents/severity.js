import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load service catalog and service map
let serviceCatalog = [];
try {
  const catalogPath = path.resolve(__dirname, '../../ml/data/service_catalog.json');
  if (fs.existsSync(catalogPath)) {
    serviceCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  }
} catch (e) {
  console.warn('[Severity] Warning: could not load service_catalog.json:', e.message);
}

let serviceMap = {};
try {
  const mapPath = path.resolve(__dirname, '../config/service_map.json');
  if (fs.existsSync(mapPath)) {
    serviceMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  }
} catch (e) {
  console.warn('[Severity] Warning: could not load service_map.json:', e.message);
}

const catalogMap = new Map();
for (const s of serviceCatalog) {
  if (s && s.name) {
    catalogMap.set(s.name.toLowerCase(), s);
  }
}

/**
 * Resolve a service name or endpoint to catalog service record.
 */
export function resolveCatalogService(serviceOrEndpoint) {
  if (!serviceOrEndpoint || typeof serviceOrEndpoint !== 'string') return null;
  const raw = serviceOrEndpoint.trim().toLowerCase();

  // Direct match in catalog
  if (catalogMap.has(raw)) {
    return catalogMap.get(raw);
  }

  // Lookup in serviceMap
  if (serviceMap[raw]) {
    const target = serviceMap[raw].toLowerCase();
    if (catalogMap.has(target)) return catalogMap.get(target);
  }

  // Check if raw contains any known keys
  for (const [k, v] of Object.entries(serviceMap)) {
    if (raw.includes(k.toLowerCase())) {
      const target = v.toLowerCase();
      if (catalogMap.has(target)) return catalogMap.get(target);
    }
  }

  return null;
}

/**
 * Extract scope from free text using regex for scope words.
 * Returns points (0..3) or null if not detected.
 */
export function extractScopePointsFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase();

  // Scope: 'all' -> 3
  if (/\b(all|everyone|everybody|campus-wide|site-wide|globally|100%|entire campus|all users|across all courses)\b/i.test(lower)) {
    return 3;
  }
  // Scope: 'many' -> 2
  if (/\b(many|multiple users|several users|a lot of users|widespread|large group|most users|many users)\b/i.test(lower)) {
    return 2;
  }
  // Scope: 'few' -> 1
  if (/\b(few|some users|a few|small group|isolated group|handful|several students)\b/i.test(lower)) {
    return 1;
  }
  // Scope: 'single' -> 0
  if (/\b(only me|single user|just me|my account|my user|for me|single client|one user)\b/i.test(lower)) {
    return 0;
  }

  return null;
}

/**
 * Extract affected_users points if present in bundle.
 * 0 users -> 0, 1 user -> 0, 2-10 -> 1, 11-100 -> 2, >100 -> 3
 */
export function affectedUsersToScopePoints(affectedUsers) {
  if (affectedUsers === null || affectedUsers === undefined || isNaN(Number(affectedUsers))) {
    return null;
  }
  const count = Number(affectedUsers);
  if (count <= 1) return 0;
  if (count <= 10) return 1;
  if (count <= 100) return 2;
  return 3;
}

/**
 * Rules severity evaluator.
 * Uses only available features and SKIPS (does not zero-fill) missing ones.
 * MUST NOT read tier, scope, data_loss, workaround from ticket specs.
 * MUST NOT import ml/rubric.py.
 *
 * Available signals:
 * 1. Service criticality (tier 1..3 from service_catalog via service_map or service name)
 * 2. affected_users / error_rate from contextBundle
 * 3. Text regex scope words
 */
export function computeRulesSeverity({
  serviceName = null,
  contextBundle = null,
  text = ''
}) {
  // Disallow reading forbidden spec fields directly
  // 1. Service tier
  let resolvedTier = null;
  const candidateService = serviceName ||
    (contextBundle?.service) ||
    (contextBundle?.affected_systems && contextBundle.affected_systems[0]);

  if (candidateService) {
    const cat = resolveCatalogService(candidateService);
    if (cat && cat.tier) {
      resolvedTier = Number(cat.tier);
    }
  }

  // 2. Scope signals
  let scopePoints = null;

  // From affected_users in bundle
  const bundleUsers = contextBundle?.affected_users ?? contextBundle?.incident?.affected_users;
  const userScope = affectedUsersToScopePoints(bundleUsers);
  if (userScope !== null) {
    scopePoints = userScope;
  }

  // From text regex if bundle did not provide or to complement
  if (scopePoints === null && text) {
    scopePoints = extractScopePointsFromText(text);
  }

  // From error_rate in bundle if available
  const errorRate = contextBundle?.error_rate;
  if (errorRate !== undefined && errorRate !== null) {
    const rate = Number(errorRate);
    if (!isNaN(rate)) {
      if (rate >= 0.8) scopePoints = Math.max(scopePoints ?? 0, 3);
      else if (rate >= 0.3) scopePoints = Math.max(scopePoints ?? 0, 2);
      else if (rate >= 0.05) scopePoints = Math.max(scopePoints ?? 0, 1);
    }
  }

  // If neither tier nor scope could be evaluated, default to P3 (moderate)
  if (resolvedTier === null && scopePoints === null) {
    return {
      severity: 'P3',
      level: 3,
      used_features: []
    };
  }

  // Calculate severity level
  // Tier: 1 (critical) -> base severe; 2 -> moderate; 3 -> minor
  // Scope: 3 (all) -> highest; 2 (many) -> high; 1 (few) -> medium; 0 (single) -> low
  let level = 3;
  const used_features = [];

  if (resolvedTier !== null) used_features.push(`tier_${resolvedTier}`);
  if (scopePoints !== null) used_features.push(`scope_points_${scopePoints}`);

  if (resolvedTier === 1) {
    if (scopePoints === 3) level = 1;
    else if (scopePoints === 2) level = 2;
    else if (scopePoints === 1) level = 2;
    else if (scopePoints === 0) level = 3;
    else level = 2; // tier 1 default
  } else if (resolvedTier === 2) {
    if (scopePoints === 3) level = 2;
    else if (scopePoints === 2) level = 2;
    else if (scopePoints === 1) level = 3;
    else if (scopePoints === 0) level = 4;
    else level = 3; // tier 2 default
  } else if (resolvedTier === 3) {
    if (scopePoints === 3) level = 3;
    else if (scopePoints === 2) level = 3;
    else if (scopePoints === 1) level = 4;
    else if (scopePoints === 0) level = 4;
    else level = 4; // tier 3 default
  } else {
    // Only scope available
    if (scopePoints === 3) level = 2;
    else if (scopePoints === 2) level = 3;
    else if (scopePoints === 1) level = 3;
    else level = 4;
  }

  const label = `P${level}`;
  return {
    severity: label,
    level,
    used_features
  };
}

/**
 * Call ML service /classify endpoint.
 * The input must be exactly title + " " + description.
 */
export async function callClassifier(title, description, mlUrl = process.env.ML_SERVICE_URL || 'http://localhost:8001') {
  const cleanTitle = (title || '').trim();
  const cleanDesc = (description || '').trim();
  const inputText = `${cleanTitle} ${cleanDesc}`.trim();

  if (!inputText) {
    return null;
  }

  try {
    const res = await fetch(`${mlUrl}/classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: inputText }),
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    return {
      label: data.predicted_label,
      probs: data.probabilities || {}
    };
  } catch (err) {
    return null;
  }
}

/**
 * Map label P1..P4 to numeric 1..4.
 */
export function pToNumber(p) {
  if (typeof p === 'number' && p >= 1 && p <= 4) return p;
  if (!p || typeof p !== 'string') return 3;
  const match = p.trim().match(/P?([1-4])/i);
  return match ? parseInt(match[1], 10) : 3;
}

/**
 * Map numeric 1..4 to P1..P4.
 */
export function numberToP(n) {
  const clamped = Math.max(1, Math.min(4, Math.round(n)));
  return `P${clamped}`;
}

/**
 * Combine available severity components:
 * - With 3 components: median.
 * - With 2 components: round toward MORE severe (lower number, e.g. 2 and 3 -> 2).
 * - If any two components differ by > 1 level (e.g. |c1 - c2| >= 2), lower confidence and set needs_review = true.
 * - If ML down, record degraded: ["classifier_unavailable"].
 */
export function combineSeverityComponents({ rulesLevel, classifierLevel, llmLevel, isClassifierDegraded = false }) {
  const components = [];
  if (rulesLevel !== null && rulesLevel !== undefined) components.push({ name: 'rules', val: Number(rulesLevel) });
  if (classifierLevel !== null && classifierLevel !== undefined) components.push({ name: 'classifier', val: Number(classifierLevel) });
  if (llmLevel !== null && llmLevel !== undefined) components.push({ name: 'llm', val: Number(llmLevel) });

  const degraded = [];
  if (isClassifierDegraded || classifierLevel === null || classifierLevel === undefined) {
    degraded.push('classifier_unavailable');
  }

  if (components.length === 0) {
    return {
      severity: 'P3',
      level: 3,
      confidence: 0.5,
      needs_review: true,
      degraded
    };
  }

  let finalLevel = 3;
  let disagreement = false;

  // Check pairwise disagreement
  for (let i = 0; i < components.length; i++) {
    for (let j = i + 1; j < components.length; j++) {
      if (Math.abs(components[i].val - components[j].val) > 1) {
        disagreement = true;
      }
    }
  }

  const values = components.map(c => c.val).sort((a, b) => a - b);

  if (values.length === 3) {
    // Median
    finalLevel = values[1];
  } else if (values.length === 2) {
    // Two components: round toward the MORE severe (min value / lower number)
    finalLevel = Math.min(values[0], values[1]);
  } else {
    // Only one component
    finalLevel = values[0];
  }

  let confidence = 0.85;
  let needs_review = false;

  if (disagreement) {
    confidence = Math.max(0.4, confidence - 0.35);
    needs_review = true;
  }

  if (degraded.length > 0) {
    confidence = Math.max(0.5, confidence - 0.15);
  }

  return {
    severity: numberToP(finalLevel),
    level: finalLevel,
    confidence: Number(confidence.toFixed(2)),
    needs_review,
    degraded
  };
}

/**
 * Main hybrid severity calculation function.
 */
export async function computeHybridSeverity({
  title = '',
  description = '',
  serviceName = null,
  contextBundle = null,
  triageSeverity = null,
  mlUrl = process.env.ML_SERVICE_URL || 'http://localhost:8001',
  mockClassifier = null // allows unit-testing classifier responses/downtime
}) {
  const combinedText = `${title} ${description}`.trim();

  // (a) Rules
  const rulesResult = computeRulesSeverity({
    serviceName,
    contextBundle,
    text: combinedText
  });
  const rulesLevel = rulesResult.level;

  // (b) Classifier (/classify)
  let classifierResult = null;
  let isClassifierDegraded = false;

  if (mockClassifier !== undefined) {
    if (mockClassifier === null) {
      isClassifierDegraded = true;
    } else {
      classifierResult = mockClassifier;
    }
  } else {
    classifierResult = await callClassifier(title, description, mlUrl);
    if (!classifierResult) {
      isClassifierDegraded = true;
    }
  }

  const classifierLevel = classifierResult ? pToNumber(classifierResult.label) : null;

  // (c) LLM / Triage Agent
  const llmLevel = triageSeverity ? pToNumber(triageSeverity) : null;

  // Combine
  const combined = combineSeverityComponents({
    rulesLevel,
    classifierLevel,
    llmLevel,
    isClassifierDegraded
  });

  return {
    severity: combined.severity,
    confidence: combined.confidence,
    needs_review: combined.needs_review,
    components: {
      rules: rulesResult.severity,
      classifier: classifierResult ? { label: classifierResult.label, probs: classifierResult.probs } : null,
      llm: triageSeverity || null
    },
    degraded: combined.degraded
  };
}
