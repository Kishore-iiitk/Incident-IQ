/**
 * RAG Processor
 * Retrieves top matching historical incidents from the knowledge base vector index.
 * Adapts results to the exact shape expected by formatHistoricalReferences in server/agents/prompts/index.js.
 * Gracefully logs warnings and returns [] if retrieval fails, marking incident as retrieval_unavailable.
 */

import { retrieve } from '../rag/retrieve.js';
import { Incident } from '../models/index.js';

export async function runRagRetrieval({ incidentId, contextBundle }) {
  let queryText = '';

  if (typeof contextBundle === 'string') {
    queryText = contextBundle;
  } else if (contextBundle && typeof contextBundle === 'object') {
    const parts = [];
    if (contextBundle.title) parts.push(contextBundle.title);
    if (contextBundle.description) parts.push(contextBundle.description);
    if (contextBundle.summary && contextBundle.summary !== contextBundle.description) {
      parts.push(typeof contextBundle.summary === 'string' ? contextBundle.summary : JSON.stringify(contextBundle.summary));
    }
    queryText = parts.join(' ').trim();
  }

  if (!queryText) {
    queryText = 'system degradation incident';
  }

  try {
    const matches = await retrieve(queryText, { k: 3 });

    return matches.map(item => ({
      id: item.id,
      family: item.family,
      service: item.service,
      title: item.title,
      symptoms: item.symptoms,
      root_cause: item.root_cause,
      resolution: item.resolution,
      score: item.score,
      text: `Title: ${item.title}\nService: ${item.service}\nFamily: ${item.family}\nSymptoms: ${item.symptoms}\nProbable Root Cause: ${item.root_cause}\nResolution: ${item.resolution}`
    }));
  } catch (err) {
    console.warn(`[RAG] Retrieval warning for incident ${incidentId}: ${err.message}. Returning empty references.`);

    if (incidentId) {
      try {
        const incident = await Incident.findById(incidentId);
        if (incident) {
          if ('retrieval_status' in incident.schema.paths) {
            incident.retrieval_status = 'retrieval_unavailable';
            await incident.save();
          } else if ('error_message' in incident.schema.paths && !incident.error_message) {
            incident.error_message = 'retrieval_unavailable';
            await incident.save();
          }
        }
      } catch (dbErr) {
        console.warn(`[RAG] Failed to mark incident ${incidentId} as retrieval_unavailable: ${dbErr.message}`);
      }
    }

    return [];
  }
}
