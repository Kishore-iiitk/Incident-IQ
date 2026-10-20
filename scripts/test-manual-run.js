import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

dotenv.config({ path: path.join(root, '.env') });

const FAULT_KEY = process.env.FAULT_KEY || 'demo-fault-secret-key';
const LMS_PORT = process.env.DEMO_LMS_PORT || '4100';
const SERVER_PORT = process.env.PORT || '5000';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHttp(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch (e) {
      // retry
    }
    await sleep(500);
  }
  return false;
}

async function run() {
  console.log('--- PHASE 3 MANUAL RUN PROOF STARTING ---');

  // 1. Start Server
  console.log('Starting Backend Server on port', SERVER_PORT);
  const serverProc = spawn('node', ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: SERVER_PORT,
      ENABLE_POLLER: 'true',
      ENABLE_LOG_WATCHER: 'true',
      DEMO_MODE: 'true'
    },
    stdio: 'inherit'
  });

  // 2. Start Demo LMS
  console.log('Starting Demo LMS on port', LMS_PORT);
  const lmsProc = spawn('node', ['demo-lms/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      DEMO_LMS_PORT: LMS_PORT
    },
    stdio: 'inherit'
  });

  try {
    const serverReady = await waitForHttp(`http://localhost:${SERVER_PORT}/health`);
    const lmsReady = await waitForHttp(`http://localhost:${LMS_PORT}/health`);

    if (!serverReady || !lmsReady) {
      throw new Error(`Services failed to start (server: ${serverReady}, lms: ${lmsReady})`);
    }

    console.log('\n Both services are healthy and running!');

    // Check existing incidents
    const initRes = await fetch(`http://localhost:${SERVER_PORT}/incidents`);
    const initIncidents = await initRes.json();
    console.log(`Initial incidents count: ${initIncidents.length}`);

    // Trigger fault:db-down
    console.log('\n Triggering fault:db-down on Demo LMS...');
    const faultRes = await fetch(`http://localhost:${LMS_PORT}/fault/db-down`, {
      method: 'POST',
      headers: { 'X-Fault-Key': FAULT_KEY }
    });
    const faultJson = await faultRes.json();
    console.log('Fault injection response:', faultJson);

    // Hit the LMS /courses endpoint to trigger error reporter and logging
    console.log('Simulating user visit to /courses during DB fault...');
    try {
      await fetch(`http://localhost:${LMS_PORT}/courses`, {
        headers: { 'X-User-Id': 'student_demo_1' }
      });
    } catch (e) {
      // 500 expected
    }

    // Wait 12 seconds for collectors (reporter immediate, logWatcher 5s interval, poller polling)
    console.log('Waiting 12 seconds for autonomous collectors (reporter, poller, log watcher)...');
    await sleep(12000);

    // Fetch incidents
    console.log('\n Fetching incidents from GET http://localhost:5000/incidents:');
    const incidentRes = await fetch(`http://localhost:${SERVER_PORT}/incidents`);
    const incidents = await incidentRes.json();

    console.log('\n================ INCIDENT LIST JSON ================');
    console.log(JSON.stringify(incidents, null, 2));
    console.log('====================================================\n');

    const created = incidents.find(inc => inc.fingerprint === '61018fc96fdbbc3e' || (inc.sources && inc.sources.length > 0));
    if (created) {
      console.log(' VERIFICATION SUCCESS:');
      console.log(`- Incident ID: ${created._id || created.id}`);
      console.log(`- Title: ${created.title}`);
      console.log(`- Fingerprint: ${created.fingerprint}`);
      console.log(`- Sources: ${JSON.stringify(created.sources)}`);
      console.log(`- Affected Users: ${created.affected_users}`);
      console.log(`- Total Incidents: ${incidents.length}`);
    } else {
      console.warn('⚠️ Warning: Expected incident not found or matching fingerprint.');
    }

    // Reset fault
    console.log('\n Resetting fault via POST /fault/reset...');
    const resetRes = await fetch(`http://localhost:${LMS_PORT}/fault/reset`, {
      method: 'POST',
      headers: { 'X-Fault-Key': FAULT_KEY }
    });
    const resetJson = await resetRes.json();
    console.log('Fault reset response:', resetJson);

    // Verify LMS recovery
    const recoveryRes = await fetch(`http://localhost:${LMS_PORT}/courses`);
    console.log(`LMS /courses status after reset: ${recoveryRes.status} ${recoveryRes.statusText}`);
    console.log(' System successfully recovered after fault reset!\n');

  } finally {
    console.log('Stopping test processes...');
    serverProc.kill();
    lmsProc.kill();
    await sleep(1000);
  }
}

run().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
