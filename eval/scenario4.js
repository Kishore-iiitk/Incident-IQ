#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const serverUrl = process.env.INCIDENTIQ_URL || 'http://localhost:5000';
const scenario1Dir = path.join(ROOT_DIR, 'fixtures', 'scenario1');

async function submitScenario(titlePrefix) {
  const eligibleFiles = fs.readdirSync(scenario1Dir).filter(f => !f.startsWith('.') && f.toLowerCase() !== 'readme.md');

  const formData = new FormData();
  formData.append('title', `${titlePrefix}: LMS Outage due to Database Connection Failure`);
  formData.append('source', 'scenario_runner');

  for (const file of eligibleFiles) {
    const filePath = path.join(scenario1Dir, file);
    const ext = path.extname(file).toLowerCase();
    const fileBytes = fs.readFileSync(filePath);
    const blob = new Blob([fileBytes]);

    if (ext === '.log') formData.append('log', blob, file);
    else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) formData.append('screenshot', blob, file);
    else if (['.m4a', '.mp3', '.wav'].includes(ext)) formData.append('voice', blob, file);
    else if (['.txt', '.eml'].includes(ext)) formData.append('email', blob, file);
  }

  const res = await fetch(`${serverUrl}/incidents`, {
    method: 'POST',
    body: formData
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Ingest failed (${res.status}): ${JSON.stringify(body)}`);
  }

  const data = await res.json();
  return data.id;
}

async function pollIncident(incidentId, timeoutSec = 180) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutSec * 1000) {
    await new Promise(r => setTimeout(r, 2000));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    try {
      const res = await fetch(`${serverUrl}/incidents/${incidentId}`);
      if (!res.ok) continue;
      const data = await res.json();
      const status = data.incident?.status;
      process.stdout.write(`\r   [${elapsed}s] Status: ${status} ... `);

      if (status === 'review' || status === 'resolved') {
        console.log(`\n✅ Completed in ${elapsed}s!`);
        return data;
      }
      if (status === 'failed') {
        throw new Error(`Pipeline failed: ${data.incident?.error_message || 'Unknown error'}`);
      }
    } catch (e) {
      if (e.message.startsWith('Pipeline failed')) throw e;
    }
  }
  throw new Error(`Timed out after ${timeoutSec} seconds.`);
}

async function runScenario4() {
  console.log(`====================================================`);
  console.log(`🎬 IncidentIQ Scenario 4: Learning Loop & Re-occurrence`);
  console.log(`====================================================\n`);

  // Step 1: Run Scenario 1 first time
  console.log(`📍 STEP 1: Running Initial Scenario 1...`);
  const firstId = await submitScenario('Initial Run (Scenario 1)');
  console.log(`   Incident ID: ${firstId}`);
  const firstResult = await pollIncident(firstId);

  // Step 2: Mark incident as resolved with confirmed root cause & fix
  console.log(`\n📍 STEP 2: Resolving Incident ${firstId} with Confirmed Root Cause & Fix...`);
  const confirmedRootCause = 'Database connection drop caused by Postgres server shutdown on 127.0.0.1:5432.';
  const confirmedFix = 'Restarted local postgres service, refreshed connection pool, verified database reconnection.';

  const resolveRes = await fetch(`${serverUrl}/incidents/${firstId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      root_cause: confirmedRootCause,
      fix: confirmedFix,
      resolution_notes: 'Resolution verified via scenario 4 automated test harness.'
    })
  });

  if (!resolveRes.ok) {
    const errBody = await resolveRes.json().catch(() => ({}));
    throw new Error(`Resolve failed (${resolveRes.status}): ${JSON.stringify(errBody)}`);
  }

  const resolveData = await resolveRes.json();
  console.log(`   ✅ Incident resolved. Confirmed Incident ID: ${resolveData.confirmed_id || firstId}`);
  console.log(`   Title:    ${resolveData.title || firstResult.incident?.title}`);
  console.log(`   Fix:      ${confirmedFix}`);

  // Small pause to allow embedding & cache propagation
  await new Promise(r => setTimeout(r, 2000));

  // Step 3: Run the exact same fault scenario again
  console.log(`\n📍 STEP 3: Re-running Same Fault as Scenario 4...`);
  const secondId = await submitScenario('Re-occurrence (Scenario 4)');
  console.log(`   Incident ID: ${secondId}`);
  const secondResult = await pollIncident(secondId);

  // Step 4: Verify that RAG retrieved the confirmed incident at Rank 1
  console.log(`\n📍 STEP 4: Verifying Retrieval & Learning Loop Results...`);
  const analyses = secondResult.analyses || [];
  const rootCauseAnalysis = analyses.find(a => a.stage === 'root_cause')?.output;

  // Check retrieved incidents from RAG stage or contextBundle
  const ragAnalysis = analyses.find(a => a.stage === 'rag_retrieval')?.output || [];
  const top1Retrieved = ragAnalysis[0] || (secondResult.incident?.retrieved_incidents && secondResult.incident.retrieved_incidents[0]);

  console.log('----------------------------------------------------');
  console.log('🔍 Retrieval Ranking Check:');
  if (top1Retrieved) {
    const isConfirmed = top1Retrieved.confirmed || top1Retrieved.id?.startsWith('CONFIRMED-') || top1Retrieved.source === 'resolved';
    console.log(`   Rank 1 ID:    ${top1Retrieved.id || top1Retrieved.kb_id}`);
    console.log(`   Title:        ${top1Retrieved.title}`);
    console.log(`   Score:        ${top1Retrieved.score}`);
    console.log(`   Confirmed?:   ${isConfirmed ? '✅ YES (Confirmed past incident)' : '❌ NO'}`);
  } else {
    console.log('   ⚠️ No retrieved incidents found in RAG output.');
  }

  console.log('\n💡 Root Cause Analysis & Citations Check:');
  if (rootCauseAnalysis) {
    console.log(`   Probable Root Cause: ${rootCauseAnalysis.probable_root_cause}`);
    console.log(`   Confidence:          ${(rootCauseAnalysis.confidence * 100).toFixed(0)}%`);
    console.log('   Supporting Evidence:');
    if (rootCauseAnalysis.supporting_evidence && rootCauseAnalysis.supporting_evidence.length > 0) {
      for (const ev of rootCauseAnalysis.supporting_evidence) {
        console.log(`      - [${ev.evidence_id || 'UNCITED'}] "${ev.quote}"`);
      }
    }
  }

  console.log('\n====================================================');
  console.log('🎉 Scenario 4 Execution Complete!');
  console.log('====================================================\n');
}

runScenario4().catch(err => {
  console.error('\n❌ Fatal Scenario 4 Error:', err.message);
  process.exit(1);
});
