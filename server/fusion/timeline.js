/**
 * Timeline Fusion (Phase 4)
 * Merges all Evidence records on timestamps into one ordered timeline,
 * deduplicates signals (same time window + same entity), and builds
 * the context bundle for the LLM stages.
 */

import { z } from 'zod';
import { rootCauseSchema } from '../agents/prompts/index.js';

/**
 * Parse a timestamp string into a Date, returning null if unparseable.
 */
function parseTimestamp(ts) {
  if (!ts) return null;
  try {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/**
 * Determine if two timestamps are within a given window (ms).
 */
export function withinWindow(tsA, tsB, windowMs = 60000) {
  const a = parseTimestamp(tsA);
  const b = parseTimestamp(tsB);
  if (!a || !b) return false;
  return Math.abs(a.getTime() - b.getTime()) <= windowMs;
}

/**
 * Merge all evidence records into an ordered timeline.
 * @param {Array} evidenceRecords - Array of Evidence record objects
 * @returns {Array} Sorted timeline events
 */
export function buildTimeline(evidenceRecords = []) {
  const events = [];

  for (const ev of evidenceRecords) {
    if (!ev || ev.status === 'skipped') continue;

    const timestamps = ev.timestamps && ev.timestamps.length > 0
      ? ev.timestamps
      : [null];

    for (const ts of timestamps) {
      events.push({
        timestamp: ts,
        parsed: parseTimestamp(ts),
        event: ev.summary || '',
        evidence_id: ev.id || ev._id?.toString() || 'unknown',
        source: ev.source || 'unknown',
        type: ev.type || 'unknown',
        errors: Array.isArray(ev.errors) ? [...ev.errors] : [],
        entities: Array.isArray(ev.entities) ? [...ev.entities] : [],
        confidence: ev.confidence || 0
      });
    }
  }

  // Sort: events with parseable timestamps first (chronological), then unparseable
  events.sort((a, b) => {
    if (a.parsed && b.parsed) return a.parsed.getTime() - b.parsed.getTime();
    if (a.parsed && !b.parsed) return -1;
    if (!a.parsed && b.parsed) return 1;
    return 0;
  });

  return events;
}

/**
 * Merge duplicate signals (same time window + same entity) in the timeline.
 * @param {Array} timeline - Sorted timeline events
 * @param {number} windowMs - Time window for dedup (default 60s)
 * @returns {Array} Deduplicated timeline
 */
export function deduplicateTimeline(timeline = [], windowMs = 60000) {
  if (!timeline || timeline.length <= 1) return timeline;

  const merged = [];
  const used = new Set();

  for (let i = 0; i < timeline.length; i++) {
    if (used.has(i)) continue;

    const current = {
      ...timeline[i],
      merged_count: 1,
      merged_from: [timeline[i].evidence_id]
    };

    for (let j = i + 1; j < timeline.length; j++) {
      if (used.has(j)) continue;

      const other = timeline[j];

      // Check same time window
      const sameWindow = current.parsed && other.parsed
        ? Math.abs(current.parsed.getTime() - other.parsed.getTime()) <= windowMs
        : false;

      // Check overlapping entities
      const currentEntities = new Set(current.entities.map(e => String(e).toLowerCase()));
      const otherEntities = new Set(other.entities.map(e => String(e).toLowerCase()));
      const hasOverlap = [...currentEntities].some(e => otherEntities.has(e));

      if (sameWindow && hasOverlap) {
        // Merge: combine errors, entities, keep higher confidence
        current.errors = [...new Set([...current.errors, ...other.errors])];
        current.entities = [...new Set([...current.entities, ...other.entities])];
        current.confidence = Math.max(current.confidence, other.confidence);
        current.merged_count++;
        current.merged_from.push(other.evidence_id);
        if (!current.event.includes(other.event)) {
          current.event = `${current.event}; ${other.event}`;
        }
        used.add(j);
      }
    }

    merged.push(current);
  }

  return merged;
}

/**
 * Build the complete context bundle from evidence records and past incidents.
 * @param {object} params
 * @param {Array} params.evidenceRecords - All evidence records for this incident
 * @param {Array} [params.retrievedIncidents] - Past incidents from RAG
 * @param {string} [params.incidentTitle] - Incident title
 * @param {string} [params.incidentDescription] - Incident description
 * @param {string} [params.incidentId] - Incident ID
 * @returns {object} Context bundle
 */
export function buildContextBundle({
  evidenceRecords = [],
  retrievedIncidents = [],
  incidentTitle = '',
  incidentDescription = '',
  incidentId = ''
} = {}) {
  const timeline = buildTimeline(evidenceRecords);
  const dedupedTimeline = deduplicateTimeline(timeline);

  // Get top error templates from log evidence
  const logEvidence = evidenceRecords.filter(e => e.type === 'log' && Array.isArray(e.templates));
  const topErrorTemplates = logEvidence.flatMap(e => e.templates || [])
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  // Collect all unique entities
  const allEntities = [...new Set(
    evidenceRecords.flatMap(e => e.entities || [])
  )];

  // Count user reports (email/text evidence)
  const userReportsCount = evidenceRecords.filter(
    e => (e.type === 'text' || e.source === 'email' || e.source === 'user_report') && e.status !== 'skipped'
  ).length;

  // Track failed processors
  const failedProcessors = evidenceRecords
    .filter(e => e.status === 'failed')
    .map(e => ({ id: e.id, source: e.source, type: e.type, reason: e.reason || 'unknown' }));

  // Include retrieved past incidents with their KB ids so they can be cited too
  const formattedRetrieved = (retrievedIncidents || []).map(ri => ({
    kb_id: ri.id || ri.kb_id || ri._id,
    title: ri.title,
    service: ri.service,
    family: ri.family,
    symptoms: ri.symptoms,
    root_cause: ri.root_cause,
    resolution: ri.resolution,
    score: ri.score
  }));

  return {
    incident_id: incidentId,
    title: incidentTitle,
    description: incidentDescription,
    timeline: dedupedTimeline,
    top_error_templates: topErrorTemplates,
    entities: allEntities,
    user_reports_count: userReportsCount,
    failed_processors: failedProcessors,
    retrieved_incidents: formattedRetrieved,
    evidence: evidenceRecords.map(ev => ({
      id: ev.id || ev._id?.toString(),
      source: ev.source,
      type: ev.type,
      summary: ev.summary,
      entities: ev.entities || [],
      errors: ev.errors || [],
      timestamps: ev.timestamps || [],
      confidence: ev.confidence,
      status: ev.status,
      reason: ev.reason || null
    }))
  };
}

/**
 * Validate citations in a root cause result against the context bundle.
 * Any cited id that does not exist in the bundle is removed and the claim
 * is marked "uncited". Validated after LLM call with Zod.
 * @param {object} rootCauseResult - The root_cause LLM output
 * @param {object} contextBundle - The context bundle
 * @returns {object} Validated root cause result
 */
export function validateCitations(rootCauseResult, contextBundle) {
  if (!rootCauseResult) return rootCauseResult;

  // Build set of valid IDs: evidence IDs, KB IDs, timeline evidence IDs
  const validIds = new Set();

  if (contextBundle) {
    // Evidence record IDs
    if (Array.isArray(contextBundle.evidence)) {
      for (const ev of contextBundle.evidence) {
        if (ev.id) validIds.add(String(ev.id));
        if (ev._id) validIds.add(String(ev._id));
      }
    }

    // KB/retrieved incident IDs
    if (Array.isArray(contextBundle.retrieved_incidents)) {
      for (const ri of contextBundle.retrieved_incidents) {
        if (ri.kb_id) validIds.add(String(ri.kb_id));
        if (ri.id) validIds.add(String(ri.id));
      }
    }

    // Timeline evidence IDs
    if (Array.isArray(contextBundle.timeline)) {
      for (const t of contextBundle.timeline) {
        if (t.evidence_id) validIds.add(String(t.evidence_id));
        if (Array.isArray(t.merged_from)) {
          t.merged_from.forEach(id => validIds.add(String(id)));
        }
      }
    }
  }

  const validated = { ...rootCauseResult };

  if (Array.isArray(validated.supporting_evidence)) {
    validated.supporting_evidence = validated.supporting_evidence.map(item => {
      const eid = item.evidence_id;
      if (eid && validIds.has(String(eid))) {
        return {
          ...item,
          evidence_id: String(eid),
          status: 'cited'
        };
      }
      // Any cited id that does not exist in the bundle is removed and the claim is marked "uncited"
      return {
        quote: item.quote,
        evidence_id: null,
        status: 'uncited'
      };
    });
  }

  // Validate transformed result with Zod
  const zodResult = rootCauseSchema.safeParse(validated);
  if (!zodResult.success) {
    throw new Error(`Citation validation failed schema check: ${zodResult.error.message}`);
  }

  return zodResult.data;
}
