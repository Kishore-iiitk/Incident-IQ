import { Incident, Artifact, Evidence, Team, Analysis } from './models/index.js';
import { processTextReport } from './processors/textProcessor.js';
import { runFusion } from './processors/fusion.js';
import { runRagRetrieval } from './processors/rag.js';
import { processLog } from './processors/log.js';
import { processVision } from './processors/vision.js';
import { processSpeech } from './processors/speech.js';
import { processText } from './processors/text.js';
import { validateCitations } from './fusion/timeline.js';
import { runGeminiStage, getGeminiClient } from './agents/gemini.js';
import { PROMPTS, PROMPT_VERSION, routerSchema, rootCauseSchema } from './agents/prompts/index.js';

let ioInstance = null;

export function setSocketIO(io) {
  ioInstance = io;
}

export function emitEvent(eventName, payload) {
  if (ioInstance) {
    ioInstance.emit(eventName, payload);
  }
}

/**
 * Execute the end-to-end incident analysis pipeline.
 */
export async function executePipeline({ incidentId, artifactId, text, files = [] }) {
  console.log(`[Pipeline] Starting execution for Incident ${incidentId}...`);

  const incident = await Incident.findById(incidentId);
  if (!incident) {
    throw new Error(`Incident ${incidentId} not found`);
  }

  incident.status = 'processing';
  await incident.save();
  emitEvent('pipeline:started', { incidentId: incident._id.toString() });

  const runStage = async (stageName, fn) => {
    emitEvent('pipeline:stage_start', {
      incidentId: incident._id.toString(),
      stage: stageName,
      timestamp: new Date().toISOString()
    });

    try {
      const result = await fn();
      emitEvent('pipeline:stage_end', {
        incidentId: incident._id.toString(),
        stage: stageName,
        status: 'completed',
        output: result,
        timestamp: new Date().toISOString()
      });
      return result;
    } catch (stageErr) {
      console.error(`[Pipeline] Stage "${stageName}" failed for Incident ${incidentId}:`, stageErr.message);

      emitEvent('pipeline:stage_end', {
        incidentId: incident._id.toString(),
        stage: stageName,
        status: 'failed',
        error: stageErr.message,
        timestamp: new Date().toISOString()
      });

      // Update incident status to failed with error message
      incident.status = 'failed';
      incident.error_message = `Stage [${stageName}] failed: ${stageErr.message}`;
      await incident.save();

      emitEvent('pipeline:failed', {
        incidentId: incident._id.toString(),
        stage: stageName,
        error: stageErr.message
      });

      throw stageErr;
    }
  };

  try {
    // Stage 1: Evidence Processors
    const geminiClient = getGeminiClient();
    const hasFiles = Array.isArray(files) && files.length > 0;
    const stageName = hasFiles ? 'evidence_processors' : 'text_processor';

    await runStage(stageName, async () => {
      if (!hasFiles) {
        // Plain text submission fallback (Phase 1-3 behavior)
        return await processTextReport({ incidentId, artifactId, text });
      }

      // Multimodal processing: categorize files
      const logFile = files.find(f => f.originalname?.endsWith('.log') || f.mimetype?.includes('log') || f.fieldname === 'log');
      const imageFile = files.find(f => /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.originalname || '') || f.mimetype?.startsWith('image/') || f.fieldname === 'screenshot' || f.fieldname === 'image');
      const audioFile = files.find(f => /\.(m4a|mp3|wav|ogg|webm|flac|aac)$/i.test(f.originalname || '') || f.mimetype?.startsWith('audio/') || f.fieldname === 'voice' || f.fieldname === 'audio');
      const emailFiles = files.filter(f => /\.(txt|eml)$/i.test(f.originalname || '') || f.fieldname?.includes('email'));

      const processorPromises = [];
      let evCounter = 1;

      // 1. Log Processor
      if (logFile) {
        processorPromises.push(
          processLog({ filePath: logFile.path, id: `EV-${String(evCounter++).padStart(2, '0')}`, geminiClient })
        );
      } else {
        processorPromises.push(
          Promise.resolve({
            id: `EV-${String(evCounter++).padStart(2, '0')}`,
            source: 'log_file',
            type: 'log',
            summary: 'No log file provided',
            entities: [],
            errors: [],
            timestamps: [],
            confidence: 0,
            status: 'skipped',
            reason: 'No log file provided'
          })
        );
      }

      // 2. Vision Processor
      if (imageFile) {
        processorPromises.push(
          processVision({ filePath: imageFile.path, id: `EV-${String(evCounter++).padStart(2, '0')}`, geminiClient })
        );
      } else {
        processorPromises.push(
          Promise.resolve({
            id: `EV-${String(evCounter++).padStart(2, '0')}`,
            source: 'screenshot',
            type: 'image',
            summary: 'No screenshot provided',
            entities: [],
            errors: [],
            timestamps: [],
            confidence: 0,
            status: 'skipped',
            reason: 'No screenshot provided'
          })
        );
      }

      // 3. Speech Processor
      if (audioFile) {
        processorPromises.push(
          processSpeech({ filePath: audioFile.path, id: `EV-${String(evCounter++).padStart(2, '0')}`, geminiClient })
        );
      } else {
        processorPromises.push(
          Promise.resolve({
            id: `EV-${String(evCounter++).padStart(2, '0')}`,
            source: 'voice_note',
            type: 'audio',
            summary: 'No voice note provided',
            entities: [],
            errors: [],
            timestamps: [],
            confidence: 0,
            status: 'skipped',
            reason: 'No audio note provided'
          })
        );
      }

      // 4. Email Complaint Files
      for (const ef of emailFiles) {
        processorPromises.push(
          processText({ filePath: ef.path, id: `EV-${String(evCounter++).padStart(2, '0')}` })
        );
      }

      // 5. User narrative text if provided alongside files
      if (text && typeof text === 'string' && text.trim().length > 0) {
        processorPromises.push(
          processText({ content: text, id: `EV-${String(evCounter++).padStart(2, '0')}` })
        );
      }

      // Run all processors in parallel with Promise.allSettled
      const settled = await Promise.allSettled(processorPromises);
      const evidenceRecords = [];

      for (const res of settled) {
        const record = res.status === 'fulfilled'
          ? res.value
          : {
              id: `EV-${String(evCounter++).padStart(2, '0')}`,
              source: 'processor',
              type: 'unknown',
              summary: `Processor failed: ${res.reason?.message || 'Unknown error'}`,
              entities: [],
              errors: [],
              timestamps: [],
              confidence: 0,
              status: 'failed',
              reason: res.reason?.message || 'Unknown error'
            };

        // Persist to Evidence model in MongoDB
        await Evidence.create({
          id: record.id,
          incident_id: incident._id,
          artifact_id: artifactId || null,
          source: record.source,
          type: record.type,
          summary: record.summary,
          entities: record.entities || [],
          errors: record.errors || [],
          timestamps: record.timestamps || [],
          confidence: record.confidence || 0,
          status: record.status || 'ok',
          reason: record.reason || null,
          metadata: {
            templates: record.templates,
            ocrText: record.ocrText,
            visionResult: record.visionResult,
            speechResult: record.speechResult,
            sentiment: record.sentiment,
            impact: record.impact
          }
        });

        evidenceRecords.push(record);
      }

      return evidenceRecords;
    });

    // Stage 2: Fusion
    const contextBundle = await runStage('fusion', async () => {
      const bundle = await runFusion({ incidentId });
      await Analysis.create({
        incident_id: incident._id,
        stage: 'fusion',
        output: bundle,
        model: 'fusion-engine',
        prompt_version: PROMPT_VERSION,
        latency_ms: 1
      });
      return bundle;
    });

    // Stage 3: RAG Retrieval
    const pastIncidents = await runStage('rag_retrieval', async () => {
      return await runRagRetrieval({ incidentId, contextBundle });
    });

    // Augment contextBundle with retrieved past incidents (including their KB ids for citation)
    if (contextBundle) {
      contextBundle.retrieved_incidents = (pastIncidents || []).map(ri => ({
        kb_id: ri.id || ri.kb_id || ri._id,
        title: ri.title,
        service: ri.service,
        family: ri.family,
        symptoms: ri.symptoms,
        root_cause: ri.root_cause,
        resolution: ri.resolution,
        score: ri.score
      }));
    }

    // Stage 4: Triage Agent
    const triageResult = await runStage('triage', async () => {
      const prompt = PROMPTS.triage.buildUserPrompt({
        contextBundle,
        historicalReferences: pastIncidents
      });
      const { output } = await runGeminiStage({
        stage: 'triage',
        systemPrompt: PROMPTS.triage.system,
        userPrompt: prompt,
        incidentId: incident._id
      });

      // Update incident with triage findings
      incident.severity = output.severity;
      incident.affected_systems = output.affected_systems;
      incident.confidence = output.confidence;
      await incident.save();

      return output;
    });

    // Stage 5: Root Cause Agent (Uses GEMINI_MODEL_STRONG)
    const rootCauseResult = await runStage('root_cause', async () => {
      const prompt = PROMPTS.root_cause.buildUserPrompt({
        contextBundle,
        triageOutput: triageResult,
        historicalReferences: pastIncidents
      });
      const { output } = await runGeminiStage({
        stage: 'root_cause',
        systemPrompt: PROMPTS.root_cause.system,
        userPrompt: prompt,
        incidentId: incident._id,
        isStrongModel: true
      });

      // Validate citations against contextBundle and validate with Zod
      const validatedOutput = validateCitations(output, contextBundle);

      // Update persisted analysis record with the validated citations
      await Analysis.findOneAndUpdate(
        { incident_id: incident._id, stage: 'root_cause' },
        { output: validatedOutput },
        { sort: { createdAt: -1 } }
      );

      return validatedOutput;
    });

    // Stage 6: Router (Rule match on Teams table first, LLM fallback if no match)
    const routerResult = await runStage('router', async () => {
      const teams = await Team.find();
      const affected = triageResult.affected_systems || [];
      const lowerText = (text || contextBundle.description || '').toLowerCase();

      let matchedTeam = null;
      let matchReason = null;

      // 1. Try matching triage affected_systems against teams.owned_systems
      for (const team of teams) {
        for (const system of team.owned_systems) {
          const sysLower = system.toLowerCase();
          if (affected.some(aff => aff.toLowerCase().includes(sysLower) || sysLower.includes(aff.toLowerCase()))) {
            matchedTeam = team.name;
            matchReason = `Deterministic system rule: affected subsystem "${system}" is owned by team "${team.name}".`;
            break;
          }
        }
        if (matchedTeam) break;
      }

      // 2. Try matching text keywords against teams.owned_systems
      if (!matchedTeam) {
        for (const team of teams) {
          for (const system of team.owned_systems) {
            if (lowerText.includes(system.toLowerCase())) {
              matchedTeam = team.name;
              matchReason = `Deterministic text match: symptom mentions owned system "${system}" belonging to "${team.name}".`;
              break;
            }
          }
          if (matchedTeam) break;
        }
      }

      let routerOutput = null;

      if (matchedTeam) {
        console.log(`[Router] Teams table match found: ${matchedTeam}`);
        routerOutput = {
          team: matchedTeam,
          reasons: [matchReason]
        };

        // Record analysis for router stage
        await Analysis.create({
          incident_id: incident._id,
          stage: 'router',
          output: routerOutput,
          model: 'rule-engine (teams table)',
          prompt_version: PROMPT_VERSION,
          latency_ms: 1
        });
      } else {
        // Fallback to LLM Router agent if no owned system matches
        console.log('[Router] No direct team match found. Asking Gemini router agent...');
        const prompt = PROMPTS.router.buildUserPrompt({
          triageOutput: triageResult,
          rootCauseOutput: rootCauseResult,
          contextBundle
        });
        const { output } = await runGeminiStage({
          stage: 'router',
          systemPrompt: PROMPTS.router.system,
          userPrompt: prompt,
          schema: routerSchema,
          incidentId: incident._id
        });
        routerOutput = output;
      }

      // Update incident with assigned team
      incident.assigned_team = routerOutput.team;
      await incident.save();

      return routerOutput;
    });

    // Stage 7: Writer Agent
    const writerResult = await runStage('writer', async () => {
      const prompt = PROMPTS.writer.buildUserPrompt({
        triageOutput: triageResult,
        rootCauseOutput: rootCauseResult,
        routerOutput: routerResult,
        contextBundle
      });
      const { output } = await runGeminiStage({
        stage: 'writer',
        systemPrompt: PROMPTS.writer.system,
        userPrompt: prompt,
        incidentId: incident._id
      });
      return output;
    });

    // Mark incident ready for review
    incident.status = 'review';
    incident.needs_review = true;
    if (writerResult?.bug_report?.title) {
      incident.title = writerResult.bug_report.title;
    }
    await incident.save();

    emitEvent('pipeline:completed', {
      incidentId: incident._id.toString(),
      status: 'review',
      severity: incident.severity,
      assigned_team: incident.assigned_team
    });

    console.log(`[Pipeline] Successfully completed Incident ${incidentId}. Status: review.`);
    return incident;
  } catch (err) {
    console.error(`[Pipeline] Execution terminated with error for Incident ${incidentId}:`, err.message);
    throw err;
  }
}

// In-process asynchronous job queue
class PipelineQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
  }

  enqueue(job) {
    this.queue.push(job);
    setImmediate(() => this.processNext());
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;
    const currentJob = this.queue.shift();

    try {
      await executePipeline(currentJob);
    } catch (err) {
      console.error(`[PipelineQueue] Job execution error for incident ${currentJob.incidentId}:`, err.message);
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0) {
        setImmediate(() => this.processNext());
      }
    }
  }

  size() {
    return this.queue.length;
  }
}

export const pipelineQueue = new PipelineQueue();
