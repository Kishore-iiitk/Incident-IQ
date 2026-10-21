import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeFingerprint } from '../server/utils/fingerprint.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');

if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

/**
 * Build 6 known fault groups with 5 synthetic reports each across poller, reporter, log_watcher,
 * plus 5 unrelated noise signals.
 */
function buildSyntheticReports() {
  const groups = [
    {
      groupId: 'G1',
      name: 'Database Outage',
      template: (i, src) => ({
        source: src,
        service: 'demo-lms',
        endpoint: '/courses',
        status: 500,
        message: 'Client must be connected before running operations',
        stack: src === 'log_watcher' ? 'Error: Client must be connected at db.js:52' : undefined,
        user_role: src === 'reporter' ? 'student' : undefined,
        user_id: src === 'reporter' ? `student_${i}` : undefined
      })
    },
    {
      groupId: 'G2',
      name: 'Upload Buffer Failure',
      template: (i, src) => ({
        source: src,
        service: 'demo-lms',
        endpoint: '/upload',
        status: 500,
        message: 'UploadServiceFailure: Failed to allocate attachment buffer',
        stack: src === 'log_watcher' ? 'Error: UploadServiceFailure at upload.js:101' : undefined,
        user_role: src === 'reporter' ? 'student' : undefined,
        user_id: src === 'reporter' ? `student_${i}` : undefined
      })
    },
    {
      groupId: 'G3',
      name: 'Slow Login Latency',
      template: (i, src) => ({
        source: src,
        service: 'demo-lms',
        endpoint: '/login',
        status: 200,
        latency_ms: 4200,
        message: 'High latency detected: 4200ms',
        user_role: src === 'reporter' ? 'student' : undefined,
        user_id: src === 'reporter' ? `student_${i}` : undefined
      })
    },
    {
      groupId: 'G4',
      name: 'Course Catalog 404',
      template: (i, src) => ({
        source: src,
        service: 'demo-lms',
        endpoint: '/courses/catalog',
        status: 404,
        message: 'Course catalog resource not found',
        user_role: src === 'reporter' ? 'student' : undefined,
        user_id: src === 'reporter' ? `student_${i}` : undefined
      })
    },
    {
      groupId: 'G5',
      name: 'Auth Token Expired',
      template: (i, src) => ({
        source: src,
        service: 'auth-service',
        endpoint: '/oauth/token',
        status: 401,
        message: 'SAML token expired or signature invalid',
        user_role: src === 'reporter' ? 'instructor' : undefined,
        user_id: src === 'reporter' ? `inst_${i}` : undefined
      })
    },
    {
      groupId: 'G6',
      name: 'Payment Processing Timeout',
      template: (i, src) => ({
        source: src,
        service: 'payments',
        endpoint: '/checkout/pay',
        status: 504,
        latency_ms: 10500,
        message: 'Gateway Timeout connecting to payment rail',
        user_role: src === 'reporter' ? 'student' : undefined,
        user_id: src === 'reporter' ? `student_${i}` : undefined
      })
    }
  ];

  const reports = [];
  const sources = ['poller', 'reporter', 'log_watcher', 'reporter', 'poller'];

  groups.forEach(g => {
    for (let i = 0; i < 5; i++) {
      const src = sources[i];
      reports.push({
        reportId: `${g.groupId}_R${i + 1}`,
        trueGroup: g.groupId,
        signal: g.template(i + 1, src)
      });
    }
  });

  // 5 Unrelated Noise Reports
  const noiseSignals = [
    { service: 'library-search', endpoint: '/search', status: 200, latency_ms: 120, message: 'Normal search query' },
    { service: 'parking-service', endpoint: '/permit', status: 400, message: 'Invalid license plate' },
    { service: 'campus-map', endpoint: '/tiles', status: 200, latency_ms: 45, message: 'Tile served' },
    { service: 'cafeteria-menu', endpoint: '/today', status: 200, message: 'Menu items returned' },
    { service: 'wifi-portal', endpoint: '/guest', status: 403, message: 'Guest quota exceeded' }
  ];

  noiseSignals.forEach((sig, idx) => {
    reports.push({
      reportId: `NOISE_${idx + 1}`,
      trueGroup: `NOISE_${idx + 1}`, // each noise is its own unique cluster
      signal: { source: 'reporter', ...sig }
    });
  });

  return reports;
}

async function runEval() {
  console.log(`=======================================================`);
  console.log(`📊 Evaluating Grouping Dedup Precision & Recall`);
  console.log(`=======================================================\n`);

  const reports = buildSyntheticReports();
  console.log(`Generated ${reports.length} synthetic reports (6 fault groups x 5 + 5 noise).`);

  // Compute fingerprints for each report
  const clusters = new Map();
  for (const r of reports) {
    const fp = computeFingerprint(r.signal);
    r.predictedGroup = fp;
    if (!clusters.has(fp)) clusters.set(fp, []);
    clusters.get(fp).push(r.reportId);
  }

  // Calculate pairwise precision and recall:
  // For every pair (i, j) with i < j:
  // Same true group -> Positive
  // Different true group -> Negative
  // Same predicted cluster -> Predicted Positive
  // Different predicted cluster -> Predicted Negative
  let TP = 0;
  let FP = 0;
  let FN = 0;
  let TN = 0;

  const n = reports.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sameTrue = reports[i].trueGroup === reports[j].trueGroup;
      const samePred = reports[i].predictedGroup === reports[j].predictedGroup;

      if (sameTrue && samePred) TP++;
      else if (!sameTrue && samePred) FP++;
      else if (sameTrue && !samePred) FN++;
      else if (!sameTrue && !samePred) TN++;
    }
  }

  const precision = (TP + FP) > 0 ? TP / (TP + FP) : 1;
  const recall = (TP + FN) > 0 ? TP / (TP + FN) : 1;
  const f1 = (precision + recall) > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  const payload = {
    metadata: {
      total_reports: reports.length,
      num_clusters_formed: clusters.size,
      pairwise_counts: { TP, FP, FN, TN },
      precision: Number(precision.toFixed(4)),
      recall: Number(recall.toFixed(4)),
      f1_score: Number(f1.toFixed(4)),
      timestamp: new Date().toISOString()
    },
    clusters: Array.from(clusters.entries()).map(([fp, members]) => ({
      fingerprint: fp,
      member_count: members.length,
      members
    })),
    limitations: "Evaluated on 35 synthetic multi-source reports (6 true fault groups across poller/reporter/log_watcher plus 5 noise signals) within an in-memory window."
  };

  fs.writeFileSync(path.join(RESULTS_DIR, 'dedup_results.json'), JSON.stringify(payload, null, 2), 'utf8');

  let md = `# Deduplication Grouping Evaluation Report\n\n`;
  md += `## 1. Pairwise Grouping Metrics\n\n`;
  md += `| Metric | Value | Description |\n`;
  md += `|---|---|---|\n`;
  md += `| **Pairwise Precision** | **${(precision * 100).toFixed(1)}%** | Fraction of report pairs clustered together that truly belong to the same incident |\n`;
  md += `| **Pairwise Recall** | **${(recall * 100).toFixed(1)}%** | Fraction of report pairs belonging to the same incident that were grouped together |\n`;
  md += `| **Pairwise F1** | **${f1.toFixed(4)}** | Harmonic mean of clustering precision and recall |\n`;
  md += `| **True Positives (TP)** | ${TP} | Correctly grouped report pairs |\n`;
  md += `| **False Positives (FP)** | ${FP} | Erroneously grouped report pairs (over-merging) |\n`;
  md += `| **False Negatives (FN)** | ${FN} | Missed group linkages (under-merging) |\n`;
  md += `| **True Negatives (TN)** | ${TN} | Correctly separated report pairs |\n\n`;

  md += `## 2. Cluster Formation Summary\n\n`;
  md += `- **Total Ingested Reports**: ${reports.length}\n`;
  md += `- **Distinct Incident Clusters Formed**: ${clusters.size}\n\n`;
  md += `| Fingerprint | Member Count | Report IDs |\n`;
  md += `|---|---|---|\n`;
  for (const c of payload.clusters) {
    md += `| \`${c.fingerprint}\` | ${c.member_count} | ${c.members.join(', ')} |\n`;
  }

  md += `\n---\n`;
  md += `> [!NOTE]\n`;
  md += `> **Sample Size & Limitations**: ${payload.limitations}\n`;

  fs.writeFileSync(path.join(RESULTS_DIR, 'dedup_results.md'), md, 'utf8');

  console.log(`✅ Saved dedup results to eval/results/dedup_results.json and dedup_results.md`);
}

runEval().catch(err => {
  console.error('Fatal eval_dedup error:', err);
  process.exit(1);
});
