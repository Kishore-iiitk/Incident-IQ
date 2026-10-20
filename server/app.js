import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { Incident, Artifact, Evidence, Analysis, Team } from './models/index.js';
import { pipelineQueue, emitEvent } from './pipeline.js';
import { dedupSignal } from './services/dedup.js';
import { redactSensitiveData } from './utils/redactor.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // Dynamic real health check (never hardcoded to true)
  app.get('/health', async (req, res) => {
    const dbStateMap = {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting'
    };
    const readyState = mongoose.connection.readyState;
    const isHealthy = readyState === 1;

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'healthy' : 'degraded',
      database: dbStateMap[readyState] || 'unknown',
      queue_pending_jobs: pipelineQueue.size(),
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
  });

  // GET /incidents - list all incidents
  app.get('/incidents', async (req, res) => {
    try {
      const incidents = await Incident.find().sort({ created_at: -1 }).limit(100);
      res.json(incidents);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch incidents', details: err.message });
    }
  });

  // GET /incidents/:id - detailed view with evidence and analyses
  app.get('/incidents/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const incident = await Incident.findById(id);
      if (!incident) {
        return res.status(404).json({ error: 'Incident not found' });
      }

      const evidence = await Evidence.find({ incident_id: id });
      const analyses = await Analysis.find({ incident_id: id }).sort({ created_at: 1 });
      const artifacts = await Artifact.find({ incident_id: id });

      res.json({
        incident,
        evidence,
        analyses,
        artifacts
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch incident details', details: err.message });
    }
  });

  // POST /incidents - handles both user text submissions and automated collector signals
  app.post('/incidents', async (req, res) => {
    try {
      const isSignal = Boolean(
        req.body.service ||
        (req.body.source && req.body.source !== 'user_submission')
      );

      if (isSignal) {
        // Automatic signal from collector (reporter, poller, log_watcher, or structured user signal)
        const {
          source = 'reporter',
          service = 'demo-lms',
          endpoint = '',
          status,
          latency_ms,
          count = 1,
          user_role,
          user_id,
          timestamp = new Date().toISOString()
        } = req.body;

        // Apply redactor to message and stack
        const rawMessage = req.body.message || '';
        const rawStack = req.body.stack || '';
        const cleanMessage = rawMessage ? redactSensitiveData(rawMessage) : '';
        const cleanStack = rawStack ? redactSensitiveData(rawStack) : '';

        // Build short title
        let derivedTitle = req.body.title;
        if (!derivedTitle) {
          const detail = cleanMessage ? cleanMessage.slice(0, 50) : (status ? `HTTP ${status}` : (latency_ms ? `${latency_ms}ms latency` : 'Anomaly'));
          derivedTitle = `[${source.toUpperCase()}] ${service}${endpoint ? ' ' + endpoint : ''} - ${detail}`;
        }
        if (derivedTitle.length > 80) {
          derivedTitle = `${derivedTitle.substring(0, 77)}...`;
        }

        // Build short description for the pipeline
        const descriptionParts = [
          `Automatic signal detected from ${source} for service "${service}".`,
          endpoint ? `Endpoint: ${endpoint}` : null,
          status ? `HTTP Status: ${status}` : null,
          latency_ms ? `Response Latency: ${latency_ms}ms` : null,
          user_role ? `User Role: ${user_role}` : null,
          cleanMessage ? `Message: ${cleanMessage}` : null,
          cleanStack ? `Stack Trace:\n${cleanStack}` : null
        ].filter(Boolean);
        const derivedDescription = descriptionParts.join('\n');

        const signalObj = {
          source,
          service,
          endpoint,
          message: cleanMessage,
          stack: cleanStack,
          status,
          latency_ms,
          count,
          user_role,
          user_id,
          timestamp
        };

        const { incident, artifact, isNew, fingerprint } = await dedupSignal(
          signalObj,
          derivedTitle,
          derivedDescription
        );

        if (isNew) {
          // Emit socket event for new incident
          emitEvent('incident:created', incident);

          // Enqueue pipeline job on the in-process async queue
          pipelineQueue.enqueue({
            incidentId: incident._id,
            artifactId: artifact._id,
            text: derivedDescription
          });

          return res.status(202).json({
            id: incident._id.toString(),
            status: incident.status,
            fingerprint,
            is_new: true,
            sources: incident.sources,
            message: 'Incident recorded and queued for analysis'
          });
        } else {
          // Emitted event for updated incident
          emitEvent('incident:updated', incident);

          return res.status(200).json({
            id: incident._id.toString(),
            status: incident.status,
            fingerprint,
            is_new: false,
            sources: incident.sources,
            affected_users: incident.affected_users,
            message: 'Signal deduplicated and attached to existing incident'
          });
        }
      }

      // Existing user-text path
      const { text, title, source = 'user_submission' } = req.body;

      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return res.status(400).json({ error: 'Incident text description is required' });
      }

      const cleanText = redactSensitiveData(text.trim());
      const derivedTitle = title && title.trim().length > 0
        ? title.trim()
        : cleanText.length > 70
          ? `${cleanText.substring(0, 67)}...`
          : cleanText;

      // 1. Create incident record in 'processing' status
      const incident = await Incident.create({
        title: derivedTitle,
        description: cleanText,
        status: 'processing',
        sources: [source],
        affected_users: 1,
        needs_review: true,
        created_at: new Date(),
        last_seen: new Date()
      });

      // 2. Create artifact record for raw text submission
      const artifact = await Artifact.create({
        incident_id: incident._id,
        kind: 'text',
        source,
        received_at: new Date()
      });

      emitEvent('incident:created', incident);

      // 3. Return ID immediately (non-blocking)
      res.status(202).json({
        id: incident._id.toString(),
        status: incident.status,
        message: 'Incident recorded and queued for analysis'
      });

      // 4. Enqueue pipeline job on the in-process async queue
      pipelineQueue.enqueue({
        incidentId: incident._id,
        artifactId: artifact._id,
        text: cleanText
      });
    } catch (err) {
      console.error('[API] Error creating incident:', err.message);
      res.status(500).json({ error: 'Failed to create incident', details: err.message });
    }
  });

  // GET /teams - list seeded teams
  app.get('/teams', async (req, res) => {
    try {
      const teams = await Team.find();
      res.json(teams);
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch teams', details: err.message });
    }
  });

  return app;
}
