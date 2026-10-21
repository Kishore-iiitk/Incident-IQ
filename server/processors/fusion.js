import { Evidence, Incident } from '../models/index.js';
import { buildContextBundle } from '../fusion/timeline.js';

/**
 * Fusion Processor
 * Builds a single coherent timeline and a normalized context bundle from all evidence records.
 */
export async function runFusion({ incidentId, retrievedIncidents = [] }) {
  const incident = await Incident.findById(incidentId);
  if (!incident) {
    throw new Error(`Incident not found for fusion: ${incidentId}`);
  }

  const evidenceRecords = await Evidence.find({ incident_id: incidentId });

  // Map to plain objects
  const mappedRecords = evidenceRecords.map(ev => ({
    id: ev.id || ev._id.toString(),
    _id: ev._id,
    source: ev.source,
    type: ev.type,
    summary: ev.summary,
    entities: ev.entities || [],
    errors: ev.errors || [],
    timestamps: ev.timestamps || [],
    confidence: ev.confidence,
    status: ev.status,
    reason: ev.reason || null,
    templates: ev.templates || ev.metadata?.templates
  }));

  const contextBundle = buildContextBundle({
    evidenceRecords: mappedRecords,
    retrievedIncidents,
    incidentTitle: incident.title,
    incidentDescription: incident.description,
    incidentId: incident._id.toString()
  });

  return contextBundle;
}
