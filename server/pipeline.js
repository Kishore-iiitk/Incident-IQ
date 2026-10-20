import { Incident, Artifact, Team, Analysis } from './models/index.js';
import { processTextReport } from './processors/textProcessor.js';
import { runFusion } from './processors/fusion.js';
import { runRagRetrieval } from './processors/rag.js';
import { runGeminiStage } from './agents/gemini.js';
import { PROMPTS, PROMPT_VERSION, routerSchema } from './agents/prompts/index.js';

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
export async function executePipeline({ incidentId, artifactId, text }) {
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
    // Stage 1: Text Processor
    const evidenceRecord = await runStage('text_processor', async () => {
      return await processTextReport({ incidentId, artifactId, text });
    });

    // Stage 2: Fusion
    const contextBundle = await runStage('fusion', async () => {
      return await runFusion({ incidentId });
    });

    // Stage 3: RAG Retrieval (stub in Phase 1)
    const pastIncidents = await runStage('rag_retrieval', async () => {
      return await runRagRetrieval({ incidentId, contextBundle });
    });

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
      return output;
    });

    // Stage 6: Router (Rule match on Teams table first, LLM fallback if no match)
    const routerResult = await runStage('router', async () => {
      const teams = await Team.find();
      const affected = triageResult.affected_systems || [];
      const lowerText = text.toLowerCase();

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
