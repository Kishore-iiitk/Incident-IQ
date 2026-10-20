import { Incident, Artifact } from '../models/index.js';
import { computeFingerprint, deriveErrorClass } from '../utils/fingerprint.js';

// In-process per-fingerprint mutex to serialize concurrent signals for the same fingerprint
const fingerprintLocks = new Map();

async function withFingerprintLock(fingerprint, action) {
  while (fingerprintLocks.has(fingerprint)) {
    try {
      await fingerprintLocks.get(fingerprint);
    } catch {
      // Ignore previous errors and proceed when lock frees
    }
  }

  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  fingerprintLocks.set(fingerprint, promise);

  try {
    return await action();
  } finally {
    fingerprintLocks.delete(fingerprint);
    release();
  }
}

/**
 * Deduplicate and ingest a signal into the Incident database.
 *
 * Rules:
 * - If an open incident (status not in ['resolved', 'closed', 'failed']) has the same
 *   fingerprint within a 10-minute window, attach the new artifact, add the source to sources[],
 *   and update last_seen.
 * - Increment affected_users only for sources "reporter" and "user" (poller and log_watcher are synthetic).
 * - Otherwise create a new incident with the fingerprint.
 *
 * Note: Two different upload bugs within 10 minutes would merge, which is acceptable for the demo.
 */
export async function dedupSignal(signal, title, description) {
  const fingerprint = computeFingerprint(signal);
  const source = signal.source || 'user_submission';
  const role = signal.user_role || signal.userRole;
  const isProbe = role === 'probe';
  const isUserSource = (source === 'reporter' || source === 'user' || source === 'user_submission') && !isProbe;
  const userId = (!isProbe && signal.user_id) ? String(signal.user_id).trim() : null;

  return await withFingerprintLock(fingerprint, async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    // Look for existing active incident with the same fingerprint within 10 min
    const existing = await Incident.findOne({
      fingerprint,
      status: { $nin: ['resolved', 'closed'] },
      $or: [
        { last_seen: { $gte: tenMinutesAgo } },
        { created_at: { $gte: tenMinutesAgo } }
      ]
    }).sort({ created_at: -1 });

    if (existing) {
      // Incident exists within window: deduplicate and attach artifact
      const updateOps = {
        $set: { last_seen: new Date() },
        $addToSet: { sources: source }
      };

      // Distinct user incrementing:
      // Must be real user source, not probe, and must have a valid user_id.
      // Signals with no user id do not increment.
      if (isUserSource && userId) {
        const seenIds = Array.isArray(existing.affected_user_ids) ? existing.affected_user_ids : [];
        if (!seenIds.includes(userId)) {
          updateOps.$addToSet = {
            ...updateOps.$addToSet,
            affected_user_ids: userId
          };
          const currentCount = typeof existing.affected_users === 'number' ? existing.affected_users : 0;
          updateOps.$set.affected_users = currentCount + 1;
        }
      }

      const updatedIncident = await Incident.findByIdAndUpdate(
        existing._id,
        updateOps,
        { new: true }
      );

      // Create new Artifact linked to the existing incident
      const artifact = await Artifact.create({
        incident_id: existing._id,
        kind: signal.stack ? 'log' : (source === 'log_watcher' ? 'log' : 'report'),
        source,
        received_at: new Date(),
        metadata: {
          endpoint: signal.endpoint || null,
          status: signal.status || null,
          latency_ms: signal.latency_ms || null,
          count: signal.count || null,
          user_role: role || null,
          user_id: userId || null,
          error_class: deriveErrorClass(signal)
        }
      });

      return {
        incident: updatedIncident,
        artifact,
        isNew: false,
        fingerprint
      };
    }

    // No existing incident within window: create a new one
    let initialUsers = 0;
    const initialUserIds = [];

    if (isUserSource && userId) {
      initialUsers = 1;
      initialUserIds.push(userId);
    }

    const newIncident = await Incident.create({
      title,
      description,
      status: 'processing',
      fingerprint,
      sources: [source],
      affected_users: initialUsers,
      affected_user_ids: initialUserIds,
      needs_review: true,
      created_at: new Date(),
      last_seen: new Date()
    });

    const artifact = await Artifact.create({
      incident_id: newIncident._id,
      kind: signal.stack ? 'log' : (source === 'log_watcher' ? 'log' : 'report'),
      source,
      received_at: new Date(),
      metadata: {
        endpoint: signal.endpoint || null,
        status: signal.status || null,
        latency_ms: signal.latency_ms || null,
        count: signal.count || null,
        user_role: role || null,
        user_id: userId || null,
        error_class: deriveErrorClass(signal)
      }
    });

    return {
      incident: newIncident,
      artifact,
      isNew: true,
      fingerprint
    };
  });
}
