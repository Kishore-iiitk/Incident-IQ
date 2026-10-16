import { Evidence, Incident } from '../models/index.js';

/**
 * Fusion Processor
 * Builds a single coherent timeline and a normalized context bundle from all evidence records.
 */
export async function runFusion({ incidentId }) {
  const incident = await Incident.findById(incidentId);
  if (!incident) {
    throw new Error(`Incident not found for fusion: ${incidentId}`);
  }

  const evidenceRecords = await Evidence.find({ incident_id: incidentId });

  // Synthesize unified timeline events from evidence records
  const timeline = [];

  for (const ev of evidenceRecords) {
    const timeRef = ev.timestamps && ev.timestamps.length > 0 ? ev.timestamps.join(', ') : 'Incident Start';
    timeline.push({
      timestamp: timeRef,
      event: ev.summary,
      evidence_id: ev._id.toString(),
      errors: ev.errors || [],
      entities: ev.entities || []
    });
  }

  // Trivial sort if timestamps are present, otherwise chronological insertion
  const contextBundle = {
    incident_id: incident._id.toString(),
    title: incident.title,
    description: incident.description,
    timeline,
    evidence: evidenceRecords.map(ev => ({
      id: ev._id.toString(),
      source: ev.source,
      type: ev.type,
      summary: ev.summary,
      entities: ev.entities,
      errors: ev.errors,
      timestamps: ev.timestamps,
      confidence: ev.confidence,
      status: ev.status
    }))
  };

  return contextBundle;
}
