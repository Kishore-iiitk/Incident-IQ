#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import concurrently from 'concurrently';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

dotenv.config({ path: path.join(root, '.env') });

async function main() {
  console.log('====================================================');
  console.log('🚀 IncidentIQ Phase 3 Full Demo Environment Launcher');
  console.log('====================================================');

  // 1. Model existence check
  const bestModelPath = path.join(root, 'ml', 'models', 'best_model.joblib');
  if (!fs.existsSync(bestModelPath)) {
    console.error('\n❌ ERROR: Trained severity classifier model not found!');
    console.error('run python ml/train.py\n');
    process.exit(1);
  }

  // 2. Python executable discovery (.venv/Scripts, .venv/bin, system PATH)
  const candidatePythons = [
    path.join(root, '.venv', 'Scripts', 'python.exe'),
    path.join(root, '.venv', 'bin', 'python'),
    path.join(root, 'venv', 'Scripts', 'python.exe'),
    path.join(root, 'venv', 'bin', 'python')
  ];

  let pythonPath = candidatePythons.find((p) => fs.existsSync(p));
  if (!pythonPath) {
    pythonPath = process.env.PYTHON || 'python';
  }

  console.log(`[Demo Launcher] Using Python: ${pythonPath}`);
  console.log(`[Demo Launcher] Using Model: ${bestModelPath}`);

  // 3. Launch ML Service, Backend Server, and Demo-LMS via concurrently
  const commands = [
    {
      name: 'ml-service',
      command: `"${pythonPath}" -m uvicorn ml.app:app --port 8001`,
      prefixColor: 'magenta',
      env: { ...process.env }
    },
    {
      name: 'server',
      command: 'node server/index.js',
      prefixColor: 'cyan',
      env: {
        ...process.env,
        ENABLE_POLLER: 'true',
        ENABLE_LOG_WATCHER: 'true',
        ML_SERVICE_URL: 'http://localhost:8001'
      }
    },
    {
      name: 'demo-lms',
      command: 'node demo-lms/index.js',
      prefixColor: 'yellow',
      env: {
        ...process.env,
        DEMO_LMS_PORT: process.env.DEMO_LMS_PORT || '4100'
      }
    }
  ];

  const { result } = concurrently(commands, {
    killOthers: ['failure', 'success'],
    restartTries: 0
  });

  // 4. Poll ML Service /health and print status once ready
  const mlHealthUrl = 'http://localhost:8001/health';
  const checkHealth = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(mlHealthUrl);
        if (res.ok) {
          const healthData = await res.json();
          console.log('\n====================================================');
          console.log('✅ ML Service Healthy & Online on Port 8001:');
          console.log(JSON.stringify(healthData, null, 2));
          console.log('====================================================\n');
          return;
        }
      } catch {
        // Wait and retry
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.warn('\n⚠️ [Demo Launcher] Warning: ML service did not respond within 60s.\n');
  };

  checkHealth();

  result.catch((err) => {
    // Handled on shutdown/signal
  });
}

main().catch((err) => {
  console.error('[Demo Launcher] Error:', err);
  process.exit(1);
});
