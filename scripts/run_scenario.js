#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runScenario() {
  const scenarioArg = process.argv[2] || 'scenario1';
  let scenarioDir = path.resolve(scenarioArg);
  if (!fs.existsSync(scenarioDir)) {
    scenarioDir = path.join(__dirname, '..', 'fixtures', scenarioArg);
  }

  if (!fs.existsSync(scenarioDir)) {
    console.error(`❌ Scenario directory not found: ${scenarioArg} (checked ${scenarioDir})`);
    process.exit(1);
  }

  const serverUrl = process.env.INCIDENTIQ_URL || 'http://localhost:5000';
  console.log(`====================================================`);
  console.log(`🎬 IncidentIQ Scenario Runner`);
  console.log(`📂 Scenario folder: ${scenarioDir}`);
  console.log(`🌐 Target server:   ${serverUrl}`);
  console.log(`====================================================\n`);

  // Read all files in folder
  const allEntries = fs.readdirSync(scenarioDir);
  const eligibleFiles = allEntries.filter(f => {
    if (f.startsWith('.') || f.toLowerCase() === 'readme.md') return false;
    const fullPath = path.join(scenarioDir, f);
    return fs.statSync(fullPath).isFile();
  });

  if (eligibleFiles.length === 0) {
    console.error(`❌ No evidence files found in ${scenarioDir}`);
    process.exit(1);
  }

  console.log(`📦 Found ${eligibleFiles.length} file(s) in scenario:`);
  for (const f of eligibleFiles) {
    const size = (fs.statSync(path.join(scenarioDir, f)).size / 1024).toFixed(1);
    console.log(`   - ${f} (${size} KB)`);
  }
  console.log();

  // Build multipart form data
  const formData = new FormData();
  formData.append('title', `Scenario Run: ${scenarioArg}`);
  formData.append('source', 'scenario_runner');

  for (const file of eligibleFiles) {
    const filePath = path.join(scenarioDir, file);
    const ext = path.extname(file).toLowerCase();
    const fileBytes = fs.readFileSync(filePath);
    const blob = new Blob([fileBytes]);

    if (ext === '.log') {
      formData.append('log', blob, file);
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
      formData.append('screenshot', blob, file);
    } else if (['.m4a', '.mp3', '.wav', '.ogg', '.webm', '.flac', '.aac'].includes(ext)) {
      formData.append('voice', blob, file);
    } else if (['.txt', '.eml'].includes(ext)) {
      formData.append('email', blob, file);
    } else {
      console.warn(`⚠️ Skipping unsupported file extension: ${file}`);
    }
  }

  // Submit to server
  console.log(`🚀 Submitting multimodal evidence to ${serverUrl}/incidents...`);
  let incidentId;
  try {
    const res = await fetch(`${serverUrl}/incidents`, {
      method: 'POST',
      body: formData
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`❌ Ingestion failed (${res.status}):`, data);
      process.exit(1);
    }

    incidentId = data.id;
    console.log(`✅ Ingested successfully. Incident ID: ${incidentId} (Status: ${data.status})\n`);
  } catch (err) {
    console.error(`❌ Connection error: Could not connect to IncidentIQ server at ${serverUrl}`);
    console.error(`   Make sure the server is running (e.g. npm start or npm run dev:server)`);
    console.error(`   Error details: ${err.message}`);
    process.exit(1);
  }

  // Poll until completion (3 minutes timeout)
  console.log(`⏳ Polling pipeline progress for Incident ${incidentId} (max 3 minutes)...`);
  const startTime = Date.now();
  const timeoutMs = 3 * 60 * 1000;
  let finalData = null;

  while (Date.now() - startTime < timeoutMs) {
    await new Promise(r => setTimeout(r, 2000));
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);

    try {
      const res = await fetch(`${serverUrl}/incidents/${incidentId}`);
      if (!res.ok) continue;

      const data = await res.json();
      const status = data.incident?.status;
      process.stdout.write(`\r   [${elapsedSec}s] Status: ${status} ... `);

      if (status === 'review' || status === 'resolved') {
        console.log(`\n🎉 Pipeline completed in ${elapsedSec}s!`);
        finalData = data;
        break;
      }

      if (status === 'failed') {
        console.log(`\n❌ Pipeline failed: ${data.incident?.error_message || 'Unknown error'}`);
        finalData = data;
        break;
      }
    } catch {
      // Retry
    }
  }

  if (!finalData) {
    console.error(`\n❌ Polling timed out after 3 minutes.`);
    process.exit(1);
  }

  // Print results
  const { incident, evidence = [], analyses = [] } = finalData;

  console.log('\n====================================================');
  console.log(`📊 SCENARIO RUN REPORT: Incident ${incident._id}`);
  console.log(`Title:    ${incident.title}`);
  console.log(`Status:   ${incident.status}`);
  console.log(`Severity: ${incident.severity || 'N/A'}`);
  console.log(`Team:     ${incident.assigned_team || 'N/A'}`);
  console.log('====================================================\n');

  // 1. Processor Statuses
  console.log(`🔍 1. PROCESSOR STATUSES (${evidence.length} Evidence Records):`);
  console.log('----------------------------------------------------');
  for (const ev of evidence) {
    const id = ev.id || 'N/A';
    const status = (ev.status || 'ok').toUpperCase();
    const conf = ev.confidence !== undefined ? `(${(ev.confidence * 100).toFixed(0)}% conf)` : '';
    console.log(`   [${id}] ${ev.source} (${ev.type}): [${status}] ${conf}`);
    console.log(`         Summary: ${ev.summary}`);
    if (ev.reason) {
      console.log(`         Reason:  ${ev.reason}`);
    }
    if (ev.errors && ev.errors.length > 0) {
      console.log(`         Errors:  ${ev.errors.join(', ')}`);
    }
    if (ev.entities && ev.entities.length > 0) {
      console.log(`         Entities: ${ev.entities.join(', ')}`);
    }
  }
  console.log();

  // 2. Fused Timeline
  const fusionAnalysis = analyses.find(a => a.stage === 'fusion')?.output;
  const timeline = fusionAnalysis?.timeline || [];
  console.log(`⏱️ 2. FUSED TIMELINE (${timeline.length} Events):`);
  console.log('----------------------------------------------------');
  if (timeline.length === 0) {
    console.log('   (No timeline events synthesized)');
  } else {
    for (const t of timeline) {
      const ts = t.timestamp || 'N/A';
      const eid = t.evidence_id || 'N/A';
      console.log(`   [${ts}] [${eid}] ${t.event}`);
      if (t.errors && t.errors.length > 0) {
        console.log(`         Errors:   ${t.errors.join(', ')}`);
      }
      if (t.entities && t.entities.length > 0) {
        console.log(`         Entities: ${t.entities.join(', ')}`);
      }
    }
  }
  console.log();

  // 3. Root Cause with Citations
  const rootCause = analyses.find(a => a.stage === 'root_cause')?.output;
  console.log('💡 3. ROOT CAUSE ANALYSIS & CITATIONS:');
  console.log('----------------------------------------------------');
  if (!rootCause) {
    console.log('   (No root cause analysis recorded)');
  } else {
    console.log(`   Probable Root Cause: ${rootCause.probable_root_cause}`);
    console.log(`   Confidence:          ${(rootCause.confidence * 100).toFixed(0)}%`);
    if (rootCause.confidence_rationale) {
      console.log(`   Rationale:           ${rootCause.confidence_rationale}`);
    }
    console.log('   Evidence Citations:');
    if (rootCause.supporting_evidence && rootCause.supporting_evidence.length > 0) {
      for (const ev of rootCause.supporting_evidence) {
        const citedTag = ev.status === 'uncited' || !ev.evidence_id
          ? '[UNCITED CLAIM]'
          : `[CITED: ${ev.evidence_id}]`;
        console.log(`      ${citedTag} "${ev.quote}"`);
      }
    } else {
      console.log('      (No supporting evidence cited)');
    }

    if (rootCause.alternative_hypotheses && rootCause.alternative_hypotheses.length > 0) {
      console.log('   Alternative Hypotheses:');
      for (const h of rootCause.alternative_hypotheses) {
        console.log(`      - [${h.likelihood}] ${h.hypothesis}: Discounted because ${h.reason_discounted}`);
      }
    }

    if (rootCause.recommended_next_checks && rootCause.recommended_next_checks.length > 0) {
      console.log('   Recommended Immediate Verification Checks:');
      for (const c of rootCause.recommended_next_checks) {
        console.log(`      - ${c}`);
      }
    }
  }
  console.log();

  // 4. Routed Team
  const router = analyses.find(a => a.stage === 'router')?.output;
  console.log('👥 4. ROUTED TEAM:');
  console.log('----------------------------------------------------');
  console.log(`   Assigned Team: ${incident.assigned_team || router?.team || 'N/A'}`);
  if (router?.reasons) {
    for (const r of router.reasons) {
      console.log(`   Reason: ${r}`);
    }
  }
  console.log();

  // 5. Incident Report
  const writer = analyses.find(a => a.stage === 'writer')?.output;
  console.log('📝 5. INCIDENT REPORT & REMEDIATION:');
  console.log('----------------------------------------------------');
  if (writer?.bug_report) {
    console.log(`   Title:               ${writer.bug_report.title}`);
    console.log(`   Suspected Component: ${writer.bug_report.suspected_component}`);
    console.log(`   Summary:             ${writer.bug_report.summary}`);
    if (writer.bug_report.steps_to_reproduce) {
      console.log('   Steps to Reproduce:');
      for (const s of writer.bug_report.steps_to_reproduce) {
        console.log(`      1. ${s}`);
      }
    }
  }
  if (writer?.suggested_fixes) {
    console.log('   Actionable Fixes:');
    for (const f of writer.suggested_fixes) {
      console.log(`      - ${f}`);
    }
  }
  if (writer?.executive_summary) {
    console.log(`   Executive Briefing:  ${writer.executive_summary}`);
  }
  console.log('\n====================================================');
  console.log('🏁 Scenario run finished.');
  console.log('====================================================\n');
}

runScenario().catch(err => {
  console.error('Fatal runner error:', err);
  process.exit(1);
});
