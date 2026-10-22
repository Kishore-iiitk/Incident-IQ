import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Incident, Artifact, Evidence, Analysis, Team, Review, ConfirmedIncident } from './models/index.js';
import { pipelineQueue, emitEvent } from './pipeline.js';
import { dedupSignal } from './services/dedup.js';
import { redactSensitiveData } from './utils/redactor.js';
import { invalidateConfirmedIncidentsCache } from './rag/retrieve.js';
import { cleanHtmlText } from './utils/htmlCleaner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configure uploads directory under server/uploads/
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${path.basename(file.originalname, ext)}-${uniqueSuffix}${ext}`);
  }
});

// Allowed file extensions
const ALLOWED_EXTS = [
  '.log',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
  '.m4a', '.mp3', '.wav', '.ogg', '.webm', '.flac', '.aac',
  '.txt', '.eml'
];

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXTS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Rejected file type: "${ext}". Only log, image, audio, and email/text files are accepted.`));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10 MB absolute max
  }
});

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
      const reviews = await Review.find({ incident_id: id }).sort({ timestamp: -1 });

      res.json({
        incident,
        evidence,
        analyses,
        artifacts,
        reviews
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch incident details', details: err.message });
    }
  });

  // POST /incidents - handles user text submissions, multipart file uploads, and automated collector signals
  app.post('/incidents', (req, res, next) => {
    upload.any()(req, res, async (err) => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }

      try {
        // Enforce per-type file size limits
        const files = req.files || [];
        for (const file of files) {
          const ext = path.extname(file.originalname).toLowerCase();
          if (ext === '.log' && file.size > 5 * 1024 * 1024) {
            return res.status(400).json({ error: `Log file "${file.originalname}" exceeds 5 MB limit` });
          }
          if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext) && file.size > 5 * 1024 * 1024) {
            return res.status(400).json({ error: `Image file "${file.originalname}" exceeds 5 MB limit` });
          }
          if (['.m4a', '.mp3', '.wav', '.ogg', '.webm', '.flac', '.aac'].includes(ext) && file.size > 10 * 1024 * 1024) {
            return res.status(400).json({ error: `Audio file "${file.originalname}" exceeds 10 MB limit` });
          }
        }

        const isSignal = files.length === 0 && Boolean(
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

          // Clean HTML tags and decode entities from message, then apply redactor
          const rawMessage = req.body.message || '';
          const rawStack = req.body.stack || '';
          const htmlCleanedMessage = cleanHtmlText(rawMessage, 200);
          const cleanMessage = htmlCleanedMessage ? redactSensitiveData(htmlCleanedMessage) : '';
          const cleanStack = rawStack ? redactSensitiveData(rawStack) : '';

          // Build short title
          // Format for poller: "[POLLER] demo-lms /login: HTTP 500 - <clean message>"
          let derivedTitle = req.body.title;
          if (!derivedTitle) {
            let detail = cleanMessage;
            if (source === 'poller') {
              const probeMatch = cleanMessage.match(/^Health probe failed with HTTP \d+:\s*(.+)$/i);
              if (probeMatch) {
                detail = probeMatch[1];
              }
              const statusPrefix = status ? `HTTP ${status} - ` : '';
              derivedTitle = `[POLLER] ${service}${endpoint ? ' ' + endpoint : ''}: ${statusPrefix}${detail || 'Service error'}`;
            } else {
              const detailShort = detail || (status ? `HTTP ${status}` : (latency_ms ? `${latency_ms}ms latency` : 'Anomaly'));
              derivedTitle = `[${source.toUpperCase()}] ${service}${endpoint ? ' ' + endpoint : ''} - ${detailShort}`;
            }
          }
          derivedTitle = cleanHtmlText(derivedTitle, 200);

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

          const { incident, artifact, isNew, isRetried, fingerprint } = await dedupSignal(
            signalObj,
            derivedTitle,
            derivedDescription
          );

          if (isNew) {
            emitEvent('incident:created', incident);

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
          } else if (isRetried) {
            emitEvent('incident:updated', incident);

            return res.status(202).json({
              id: incident._id.toString(),
              status: incident.status,
              fingerprint,
              is_new: false,
              is_retried: true,
              sources: incident.sources,
              message: 'Failed incident re-queued for analysis'
            });
          } else {
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

        // Multimodal files path
        if (files.length > 0) {
          const rawText = req.body.text || '';
          const cleanText = rawText ? redactSensitiveData(rawText.trim()) : '';
          const fileNames = files.map(f => f.originalname).join(', ');
          const derivedTitle = req.body.title && req.body.title.trim().length > 0
            ? req.body.title.trim()
            : cleanText
              ? (cleanText.length > 70 ? `${cleanText.substring(0, 67)}...` : cleanText)
              : `Multimodal Incident Ingestion: ${files.length} file(s) (${fileNames.slice(0, 50)})`;

          const description = cleanText || `Multimodal evidence submitted: ${fileNames}`;

          // Create incident record
          const incident = await Incident.create({
            title: derivedTitle,
            description,
            status: 'processing',
            sources: ['user_submission', 'multimodal_evidence'],
            affected_users: 1,
            needs_review: true,
            created_at: new Date(),
            last_seen: new Date()
          });

          // Create artifacts for uploaded files
          const createdArtifacts = [];
          for (const file of files) {
            const ext = path.extname(file.originalname).toLowerCase();
            let kind = 'report';
            if (ext === '.log') kind = 'log';
            else if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) kind = 'screenshot';
            else if (['.m4a', '.mp3', '.wav', '.ogg', '.webm', '.flac', '.aac'].includes(ext)) kind = 'voice';
            else if (['.txt', '.eml'].includes(ext)) kind = 'email';

            const art = await Artifact.create({
              incident_id: incident._id,
              kind,
              file_ref: file.path,
              source: 'user_submission',
              received_at: new Date(),
              metadata: {
                originalname: file.originalname,
                size: file.size,
                mimetype: file.mimetype
              }
            });
            createdArtifacts.push(art);
          }

          if (cleanText) {
            await Artifact.create({
              incident_id: incident._id,
              kind: 'text',
              source: 'user_submission',
              received_at: new Date()
            });
          }

          emitEvent('incident:created', incident);

          res.status(202).json({
            id: incident._id.toString(),
            status: incident.status,
            message: 'Incident recorded and queued for analysis',
            files_received: files.length
          });

          pipelineQueue.enqueue({
            incidentId: incident._id,
            artifactId: createdArtifacts[0]?._id || null,
            text: cleanText,
            files
          });

          return;
        }

        // Text-only submission path
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

        const artifact = await Artifact.create({
          incident_id: incident._id,
          kind: 'text',
          source,
          received_at: new Date()
        });

        emitEvent('incident:created', incident);

        res.status(202).json({
          id: incident._id.toString(),
          status: incident.status,
          message: 'Incident recorded and queued for analysis'
        });

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

  // POST /incidents/:id/retry - re-queue pipeline for a failed incident (only valid when status === 'failed')
  app.post('/incidents/:id/retry', async (req, res) => {
    try {
      const { id } = req.params;
      const incident = await Incident.findById(id);
      if (!incident) {
        return res.status(404).json({ error: 'Incident not found' });
      }

      if (incident.status !== 'failed') {
        return res.status(409).json({
          error: `Incident cannot be retried because its status is "${incident.status}" (must be "failed")`
        });
      }

      incident.retry_count = (incident.retry_count || 0) + 1;
      incident.status = 'processing';
      incident.error_message = null;
      incident.failed_stage = null;
      await incident.save();

      emitEvent('incident:updated', incident);

      const latestArtifact = await Artifact.findOne({ incident_id: incident._id }).sort({ received_at: -1 });

      pipelineQueue.enqueue({
        incidentId: incident._id,
        artifactId: latestArtifact?._id || null,
        text: incident.description
      });

      return res.status(202).json({
        id: incident._id.toString(),
        status: incident.status,
        retry_count: incident.retry_count,
        message: 'Incident analysis re-queued for processing'
      });
    } catch (err) {
      console.error('[API] Error retrying incident:', err.message);
      res.status(500).json({ error: 'Failed to retry incident', details: err.message });
    }
  });

  // POST /incidents/:id/review - save human review action (approve or edit)
  app.post('/incidents/:id/review', async (req, res) => {
    try {
      const { id } = req.params;
      const { field, action, new_value, reviewer = 'engineer' } = req.body;

      if (!field || !action) {
        return res.status(400).json({ error: 'field and action are required' });
      }

      const incident = await Incident.findById(id);
      if (!incident) {
        return res.status(404).json({ error: 'Incident not found' });
      }

      let oldValue = null;
      if (field === 'severity') {
        oldValue = incident.severity;
        if (action === 'edit' && new_value) {
          incident.severity = new_value;
        }
      } else if (field === 'assigned_team') {
        oldValue = incident.assigned_team;
        if (action === 'edit' && new_value) {
          incident.assigned_team = new_value;
        }
      } else if (field === 'root_cause') {
        const rcAnalysis = await Analysis.findOne({ incident_id: id, stage: 'root_cause' }).sort({ created_at: -1 });
        oldValue = rcAnalysis?.output?.probable_root_cause || null;
        if (action === 'edit' && new_value && rcAnalysis) {
          rcAnalysis.output.probable_root_cause = new_value;
          rcAnalysis.markModified('output');
          await rcAnalysis.save();
        }
      }

      // If approved or edited, clear needs_review flag
      incident.needs_review = false;
      await incident.save();

      const reviewRecord = await Review.create({
        incident_id: incident._id,
        field,
        old_value: oldValue,
        new_value: action === 'approve' ? oldValue : new_value,
        action,
        reviewer,
        timestamp: new Date()
      });

      emitEvent('incident:updated', incident);

      res.json({
        success: true,
        incident,
        review: reviewRecord
      });
    } catch (err) {
      console.error('[API] Error saving review:', err.message);
      res.status(500).json({ error: 'Failed to record review', details: err.message });
    }
  });

  // POST /incidents/:id/resolve - mark resolved and trigger learning loop
  app.post('/incidents/:id/resolve', async (req, res) => {
    try {
      const { id } = req.params;
      const { root_cause, resolution, fix, symptoms = '' } = req.body;
      const finalResolution = resolution || fix;

      if (!root_cause || !finalResolution) {
        return res.status(400).json({ error: 'confirmed root_cause and resolution (or fix) are required' });
      }

      const incident = await Incident.findById(id);
      if (!incident) {
        return res.status(404).json({ error: 'Incident not found' });
      }

      incident.status = 'resolved';
      incident.resolved_at = new Date();
      await incident.save();

      // Learning loop: Embed {title + symptoms} through the ML service (/embed)
      const embedText = `${incident.title} ${symptoms || incident.description || ''}`.trim();
      const cleanEmbedText = redactSensitiveData(embedText);
      const mlUrl = process.env.ML_SERVICE_URL || 'http://localhost:8001';

      let embedding = null;
      let pendingEmbedding = false;

      try {
        const mlRes = await fetch(`${mlUrl}/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: cleanEmbedText }),
          signal: AbortSignal.timeout(4000)
        });

        if (mlRes.ok) {
          const payload = await mlRes.json();
          embedding = payload.embedding || (payload.embeddings && payload.embeddings[0]);
        } else {
          pendingEmbedding = true;
        }
      } catch (embedErr) {
        console.warn(`[LearningLoop] ML /embed unavailable: ${embedErr.message}. Saving with pending_embedding = true.`);
        pendingEmbedding = true;
      }

      if (!Array.isArray(embedding) || embedding.length === 0) {
        embedding = null;
        pendingEmbedding = true;
      }

      // Store in confirmed_incidents collection
      const confirmedId = `CONFIRMED-${incident._id.toString()}`;
      const confirmedDoc = await ConfirmedIncident.findOneAndUpdate(
        { id: confirmedId },
        {
          id: confirmedId,
          title: incident.title,
          symptoms: symptoms || incident.description || '',
          root_cause,
          resolution: finalResolution,
          embedding,
          confirmed: true,
          source: 'resolved',
          pending_embedding: pendingEmbedding,
          created_at: new Date()
        },
        { upsert: true, new: true }
      );

      // Invalidate RAG cache when new confirmed entry is added
      invalidateConfirmedIncidentsCache();
      emitEvent('incident:updated', incident);

      res.json({
        success: true,
        incident,
        confirmed_incident: confirmedDoc,
        confirmed_id: confirmedId,
        title: incident.title,
        pending_embedding: pendingEmbedding,
        message: pendingEmbedding
          ? 'Incident resolved. Note: ML embedding service was unavailable; entry saved with pending embedding.'
          : 'Incident resolved and added to confirmed past incidents knowledge base.'
      });
    } catch (err) {
      console.error('[API] Error resolving incident:', err.message);
      res.status(500).json({ error: 'Failed to resolve incident', details: err.message });
    }
  });

  // POST /admin/embed-pending - retry embedding for confirmed incidents with pending_embedding = true
  app.post('/admin/embed-pending', async (req, res) => {
    try {
      const mlUrl = process.env.ML_SERVICE_URL || 'http://localhost:8001';
      const pendingDocs = await ConfirmedIncident.find({
        $or: [{ pending_embedding: true }, { embedding: null }, { embedding: { $size: 0 } }]
      });

      let updatedCount = 0;
      for (const doc of pendingDocs) {
        const embedText = `${doc.title} ${doc.symptoms || ''}`.trim();
        const cleanEmbedText = redactSensitiveData(embedText);
        try {
          const mlRes = await fetch(`${mlUrl}/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: cleanEmbedText }),
            signal: AbortSignal.timeout(4000)
          });
          if (mlRes.ok) {
            const payload = await mlRes.json();
            const vec = payload.embedding || (payload.embeddings && payload.embeddings[0]);
            if (Array.isArray(vec) && vec.length > 0) {
              doc.embedding = vec;
              doc.pending_embedding = false;
              await doc.save();
              updatedCount++;
            }
          }
        } catch {
          // Keep pending
        }
      }

      if (updatedCount > 0) {
        invalidateConfirmedIncidentsCache();
      }

      res.json({
        total_pending_checked: pendingDocs.length,
        successfully_embedded: updatedCount
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to process pending embeddings', details: err.message });
    }
  });

  return app;
}
