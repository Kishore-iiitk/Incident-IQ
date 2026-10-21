import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RESULTS_DIR = path.join(__dirname, 'results');

if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

async function runEval() {
  console.log(`=======================================================`);
  console.log(`📊 Evaluating Pipeline Latency (10 Runs of Scenario 1)`);
  console.log(`=======================================================\n`);

  const serverUrl = process.env.INCIDENTIQ_URL || 'http://localhost:5000';
  const scenarioDir = path.resolve(__dirname, '..', 'fixtures', 'scenario1');

  if (!fs.existsSync(scenarioDir)) {
    console.error(`❌ Fixture directory not found: ${scenarioDir}`);
    process.exit(1);
  }

  const allFiles = fs.readdirSync(scenarioDir).filter(f => !f.startsWith('.') && f.toLowerCase() !== 'readme.md');

  const runs = [];
  let failures = 0;
  let rateLimits = 0;

  for (let runIdx = 1; runIdx <= 10; runIdx++) {
    console.log(`▶️ Starting Run ${runIdx}/10...`);
    const runStart = Date.now();

    try {
      const formData = new FormData();
      formData.append('title', `Latency Eval Run ${runIdx}`);
      formData.append('source', 'eval_latency');

      for (const file of allFiles) {
        const filePath = path.join(scenarioDir, file);
        const ext = path.extname(file).toLowerCase();
        const fileBytes = fs.readFileSync(filePath);
        const blob = new Blob([fileBytes]);

        if (ext === '.log') formData.append('log', blob, file);
        else if (['.png', '.jpg', '.jpeg'].includes(ext)) formData.append('screenshot', blob, file);
        else if (['.m4a', '.mp3'].includes(ext)) formData.append('voice', blob, file);
        else if (['.txt', '.eml'].includes(ext)) formData.append('email', blob, file);
      }

      // Ingest incident
      const res = await fetch(`${serverUrl}/incidents`, {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        if (res.status === 429) rateLimits++;
        failures++;
        runs.push({ run: runIdx, duration_ms: Date.now() - runStart, status: `failed_${res.status}` });
        continue;
      }

      const data = await res.json();
      const incidentId = data.id;

      // Poll until completion (max 2 minutes)
      const timeoutMs = 2 * 60 * 1000;
      let completed = false;

      while (Date.now() - runStart < timeoutMs) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const pollRes = await fetch(`${serverUrl}/incidents/${incidentId}`);
          if (!pollRes.ok) continue;
          const pollData = await pollRes.json();
          const st = pollData.incident?.status;
          if (st === 'review' || st === 'resolved') {
            completed = true;
            break;
          }
          if (st === 'failed') {
            break;
          }
        } catch {}
      }

      const totalMs = Date.now() - runStart;
      if (completed) {
        runs.push({ run: runIdx, duration_ms: totalMs, status: 'completed' });
        console.log(`   ✅ Run ${runIdx} completed in ${(totalMs / 1000).toFixed(1)}s`);
      } else {
        failures++;
        runs.push({ run: runIdx, duration_ms: totalMs, status: 'failed' });
        console.log(`   ❌ Run ${runIdx} failed or uncompleted after ${(totalMs / 1000).toFixed(1)}s`);
      }
    } catch (err) {
      failures++;
      const totalMs = Date.now() - runStart;
      runs.push({ run: runIdx, duration_ms: totalMs, status: 'error', error: err.message });
      console.log(`   ❌ Run ${runIdx} error: ${err.message}`);
    }
  }

  const completedDurations = runs.filter(r => r.status === 'completed').map(r => r.duration_ms).sort((a, b) => a - b);
  let medianMs = 0;
  let worstCaseMs = 0;
  let bestCaseMs = 0;

  if (completedDurations.length > 0) {
    const mid = Math.floor(completedDurations.length / 2);
    medianMs = completedDurations.length % 2 === 0
      ? (completedDurations[mid - 1] + completedDurations[mid]) / 2
      : completedDurations[mid];
    bestCaseMs = completedDurations[0];
    worstCaseMs = completedDurations[completedDurations.length - 1];
  }

  const payload = {
    metadata: {
      total_runs: 10,
      completed_count: completedDurations.length,
      failure_count: failures,
      rate_limit_count: rateLimits,
      median_duration_ms: medianMs,
      worst_case_duration_ms: worstCaseMs,
      best_case_duration_ms: bestCaseMs,
      timestamp: new Date().toISOString()
    },
    runs,
    limitations: "End-to-end pipeline latency over 10 consecutive executions of Scenario 1 against local server with multimodal evidence."
  };

  fs.writeFileSync(path.join(RESULTS_DIR, 'latency_results.json'), JSON.stringify(payload, null, 2), 'utf8');

  let md = `# Pipeline Latency Evaluation Report\n\n`;
  md += `## 1. Summary Statistics (10 Runs)\n\n`;
  md += `| Metric | Duration (seconds) | Duration (ms) |\n`;
  md += `|---|---|---|\n`;
  md += `| **Median Latency** | **${(medianMs / 1000).toFixed(1)}s** | ${medianMs} ms |\n`;
  md += `| **Worst Case (Max)** | **${(worstCaseMs / 1000).toFixed(1)}s** | ${worstCaseMs} ms |\n`;
  md += `| **Best Case (Min)** | **${(bestCaseMs / 1000).toFixed(1)}s** | ${bestCaseMs} ms |\n`;
  md += `| **Completed Runs** | ${completedDurations.length} / 10 | - |\n`;
  md += `| **Failed Runs** | ${failures} | - |\n`;
  md += `| **Rate Limits (429)** | ${rateLimits} | - |\n\n`;

  md += `## 2. Per-Run Breakdown\n\n`;
  md += `| Run # | Duration (s) | Status |\n`;
  md += `|---|---|---|\n`;
  for (const r of runs) {
    md += `| Run ${r.run} | ${(r.duration_ms / 1000).toFixed(1)}s | ${r.status.toUpperCase()} |\n`;
  }

  md += `\n---\n`;
  md += `> [!NOTE]\n`;
  md += `> **Sample Size & Limitations**: ${payload.limitations}\n`;

  fs.writeFileSync(path.join(RESULTS_DIR, 'latency_results.md'), md, 'utf8');

  console.log(`✅ Saved latency results to eval/results/latency_results.json and latency_results.md`);
}

runEval().catch(err => {
  console.error('Fatal eval_latency error:', err);
  process.exit(1);
});
