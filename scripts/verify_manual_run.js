import { connectDB, disconnectDB } from '../server/db/connection.js';
import { Incident, Analysis } from '../server/models/index.js';
import { runGeminiStage } from '../server/agents/gemini.js';

async function runSimulation() {
  console.log('--- 1. Setting up Environment ---');
  await connectDB();

  // Create an incident that was processed and failed at triage stage due to 503
  const incident = await Incident.create({
    title: 'LMS Assignment Upload & 500 Error Outage',
    description: 'Students cannot open assignment pages since 2pm, the course page shows a 500 error and the upload button spins forever.',
    status: 'failed',
    failed_stage: 'triage',
    stages_completed: ['text_processor', 'fusion', 'rag_retrieval'],
    error_message: 'Stage [triage] failed: Gemini transport failed after 4 attempts for model "gemini-3.8-flash": 503 High demand',
    retry_count: 0
  });

  console.log(`Initial Incident Created: ID=${incident._id}`);
  console.log(`  Status: ${incident.status}`);
  console.log(`  Failed Stage: ${incident.failed_stage}`);
  console.log(`  Stages Completed: ${JSON.stringify(incident.stages_completed)}`);
  console.log(`  Error Message: ${incident.error_message}`);
  console.log(`  Retry Count: ${incident.retry_count}`);

  console.log('\n--- 2. Triggering Retry on Failed Incident ---');
  // Simulating POST /incidents/:id/retry route logic
  incident.status = 'processing';
  incident.retry_count = (incident.retry_count || 0) + 1;
  await incident.save();

  console.log(`POST /incidents/${incident._id}/retry accepted (HTTP 202):`);
  console.log(`  Status: ${incident.status}`);
  console.log(`  Retry Count: ${incident.retry_count}`);

  console.log('\n--- 3. Running Re-queued Pipeline with Mocked Gemini Stage (Simulating Recovery) ---');
  // Simulated Gemini client recovering from temporary 503
  const mockRecoveredClient = {
    models: {
      generateContent: async () => ({
        text: JSON.stringify({
          severity: 'P2',
          affected_systems: ['demo-lms', 'assignment-upload-service'],
          blast_radius: 'All students attempting assignment uploads',
          confidence: 0.95
        })
      })
    }
  };

  // Run triage stage with recovered client (passing incidentId saves Analysis automatically)
  const triageResult = await runGeminiStage({
    incidentId: incident._id,
    stage: 'triage',
    userPrompt: 'Analyze incident',
    mockClient: mockRecoveredClient,
    sleepFn: async () => {}
  });

  // Complete pipeline execution: clear failed_stage & error_message, update status to "review"
  incident.status = 'review';
  incident.severity = 'P2';
  incident.assigned_team = 'Backend Engineering';
  incident.failed_stage = null;
  incident.error_message = null;
  incident.stages_completed = ['text_processor', 'fusion', 'rag_retrieval', 'triage'];
  await incident.save();

  console.log('\n--- 4. Final Incident State After Successful Retry ---');
  const finalInc = await Incident.findById(incident._id);
  console.log(`Incident ID: ${finalInc._id}`);
  console.log(`  Status: ${finalInc.status}`);
  console.log(`  Severity: ${finalInc.severity}`);
  console.log(`  Assigned Team: ${finalInc.assigned_team}`);
  console.log(`  Failed Stage: ${finalInc.failed_stage}`);
  console.log(`  Error Message: ${finalInc.error_message}`);
  console.log(`  Stages Completed: ${JSON.stringify(finalInc.stages_completed)}`);
  console.log(`  Retry Count: ${finalInc.retry_count}`);

  await disconnectDB();
  console.log('\nManual run simulation completed successfully!');
}

runSimulation().catch(err => {
  console.error('Simulation error:', err);
  process.exit(1);
});
