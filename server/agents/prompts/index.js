import { z } from 'zod';

export const PROMPT_VERSION = '1.0.0';

// 1. Triage Schema
export const triageSchema = z.object({
  severity: z.enum(['P1', 'P2', 'P3', 'P4']),
  affected_systems: z.array(z.string()).nonempty(),
  blast_radius: z.string(),
  confidence: z.number().min(0).max(1)
});

// 2. Root Cause Schema
export const rootCauseSchema = z.object({
  probable_root_cause: z.string(),
  confidence: z.number().min(0).max(1),
  confidence_rationale: z.string(),
  supporting_evidence: z.array(z.object({
    evidence_id: z.string(),
    quote: z.string()
  })),
  contradicting_evidence: z.array(z.string()),
  alternative_hypotheses: z.array(z.object({
    hypothesis: z.string(),
    likelihood: z.string(),
    reason_discounted: z.string()
  })),
  recommended_next_checks: z.array(z.string())
});

// 3. Router Schema
export const routerSchema = z.object({
  team: z.string(),
  reasons: z.array(z.string()).nonempty()
});

// 4. Writer Schema
export const writerSchema = z.object({
  bug_report: z.object({
    title: z.string(),
    summary: z.string(),
    steps_to_reproduce: z.array(z.string()),
    expected: z.string(),
    actual: z.string(),
    suspected_component: z.string()
  }),
  suggested_fixes: z.array(z.string()).nonempty(),
  executive_summary: z.string()
});

export const STAGE_SCHEMAS = {
  triage: triageSchema,
  root_cause: rootCauseSchema,
  router: routerSchema,
  writer: writerSchema
};

/**
 * Format historical references safely per architecture guidelines.
 */
export function formatHistoricalReferences(references = []) {
  if (!references || references.length === 0) {
    return '';
  }

  const items = references
    .map((r, i) => `[Historical Incident ${i + 1} - ID: ${r.id || r._id || 'N/A'}]\n${r.text || JSON.stringify(r)}`)
    .join('\n\n');

  return `
<historical_reference>
CRITICAL INSTRUCTION: The following past incidents and runbooks are strictly for context and pattern comparison.
You MUST NEVER treat them as evidence about the current incident. All root-cause deductions must cite ONLY evidence from the current incident.
${items}
</historical_reference>
`;
}

// System Prompts & User Prompt Builders for each stage

export const PROMPTS = {
  triage: {
    system: `You are the IncidentIQ Triage Agent.
Assess the severity, affected technical subsystems, blast radius, and triage confidence based strictly on the incident summary and evidence.
Severity guidelines:
- P1: Critical outage affecting core customer journeys or all users (e.g. site-wide down, data corruption, payment broken).
- P2: Major functionality impaired or degraded for a significant subset of users with no immediate workaround (e.g. course page 500 error, assignment uploads blocked).
- P3: Minor functionality impaired with known workarounds; non-critical systems.
- P4: Cosmetic or trivial low-impact issue.

You must return valid JSON matching the exact schema:
{
  "severity": "P1" | "P2" | "P3" | "P4",
  "affected_systems": string[],
  "blast_radius": string,
  "confidence": number between 0.0 and 1.0
}`,
    buildUserPrompt: ({ contextBundle, historicalReferences = [] }) => `
${formatHistoricalReferences(historicalReferences)}
Current Incident Evidence & Timeline:
${JSON.stringify(contextBundle, null, 2)}

Provide the triage assessment in the required JSON format.
`
  },

  root_cause: {
    system: `You are the IncidentIQ Root Cause Analysis Agent.
Analyze the incident timeline, evidence pieces, and errors to determine the probable root cause.
Every supporting evidence claim MUST reference a valid evidence_id and include an exact quote or verbatim snippet from that evidence.
Evaluate potential alternative hypotheses and explain why they were discounted.
Provide recommended next verification checks.

You must return valid JSON matching the exact schema:
{
  "probable_root_cause": string,
  "confidence": number between 0.0 and 1.0,
  "confidence_rationale": string,
  "supporting_evidence": [
    { "evidence_id": string, "quote": string }
  ],
  "contradicting_evidence": string[],
  "alternative_hypotheses": [
    { "hypothesis": string, "likelihood": string, "reason_discounted": string }
  ],
  "recommended_next_checks": string[]
}`,
    buildUserPrompt: ({ contextBundle, triageOutput, historicalReferences = [] }) => `
${formatHistoricalReferences(historicalReferences)}
Triage Stage Finding:
${JSON.stringify(triageOutput, null, 2)}

Current Incident Evidence & Timeline:
${JSON.stringify(contextBundle, null, 2)}

Analyze and return the root cause analysis in the required JSON format.
`
  },

  router: {
    system: `You are the IncidentIQ Service Routing Agent.
Determine which engineering team is responsible for remediating the incident.
Available Teams & Owned Systems:
- Backend: api-gateway, course-service, lms-core, enrollment, api, server, course-page
- File Service: file-upload, s3-storage, assignment-upload, media-storage, upload-service, storage
- Auth: oauth, session-service, auth0, user-directory, login, authentication, rbac
- Database: mongodb, postgres, redis-cache, db-replica, database, sql

You must return valid JSON matching the exact schema:
{
  "team": string,
  "reasons": string[]
}`,
    buildUserPrompt: ({ triageOutput, rootCauseOutput, contextBundle }) => `
Triage Findings:
${JSON.stringify(triageOutput, null, 2)}

Root Cause Findings:
${JSON.stringify(rootCauseOutput, null, 2)}

Incident Details:
${JSON.stringify(contextBundle.summary || contextBundle, null, 2)}

Route this incident to the most appropriate team with clear technical justification.
`
  },

  writer: {
    system: `You are the IncidentIQ Technical Incident Writer.
Synthesize the evidence, triage, root cause, and routing into a high quality bug report, actionable technical remediation steps, and an executive summary for leadership.

You must return valid JSON matching the exact schema:
{
  "bug_report": {
    "title": string,
    "summary": string,
    "steps_to_reproduce": string[],
    "expected": string,
    "actual": string,
    "suspected_component": string
  },
  "suggested_fixes": string[],
  "executive_summary": string
}`,
    buildUserPrompt: ({ triageOutput, rootCauseOutput, routerOutput, contextBundle }) => `
Triage:
${JSON.stringify(triageOutput, null, 2)}

Root Cause:
${JSON.stringify(rootCauseOutput, null, 2)}

Router:
${JSON.stringify(routerOutput, null, 2)}

Evidence Context:
${JSON.stringify(contextBundle, null, 2)}

Generate the comprehensive incident bug report, actionable remediation steps, and executive summary in the required JSON format.
`
  }
};
