import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { Incident, Artifact, Evidence, Analysis, Team } from './models/index.js';
import { pipelineQueue } from './pipeline.js';

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

  // POST /incidents - accepts free text, creates incident + artifact, returns immediately
  app.post('/incidents', async (req, res) => {
    try {
      const { text, title, source = 'user_submission' } = req.body;

      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return res.status(400).json({ error: 'Incident text description is required' });
      }

      const cleanText = text.trim();
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
        needs_review: true,
        created_at: new Date()
      });

      // 2. Create artifact record for raw text submission
      const artifact = await Artifact.create({
        incident_id: incident._id,
        kind: 'text',
        source,
        received_at: new Date()
      });

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
