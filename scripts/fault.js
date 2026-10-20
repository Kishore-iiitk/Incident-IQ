#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const action = process.argv[2];
const validActions = ['db-down', 'upload-error', 'slow-login', 'reset'];

if (!action || !validActions.includes(action)) {
  console.error(`Usage: node scripts/fault.js <${validActions.join('|')}>`);
  process.exit(1);
}

const faultKey = process.env.FAULT_KEY || 'demo-fault-secret-key';
const lmsUrl = process.env.DEMO_LMS_URL || `http://localhost:${process.env.DEMO_LMS_PORT || 4100}`;
const targetUrl = `${lmsUrl}/fault/${action}`;

async function runFault() {
  console.log(`[Fault CLI] Injecting fault action: "${action}" -> ${targetUrl}`);

  try {
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Fault-Key': faultKey
      }
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[Fault CLI] Failed (${res.status}):`, body);
      process.exit(1);
    }

    console.log(`[Fault CLI] Success (${res.status}):`, JSON.stringify(body, null, 2));
  } catch (err) {
    console.error(`[Fault CLI] Request error connecting to Demo-LMS at ${lmsUrl}:`, err.message);
    process.exit(1);
  }
}

runFault();
