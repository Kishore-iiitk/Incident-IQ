import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeRulesSeverity, callClassifier, combineSeverityComponents, pToNumber, numberToP } from '../server/agents/severity.js';
import { computeClassificationMetrics } from './metrics.js';
import { withLlmCache } from './llm_cache.js';
import { runGeminiStage } from '../server/agents/gemini.js';
import { PROMPTS, triageSchema } from '../server/agents/prompts/index.js';
import { SCENARIOS } from './scenarios/definitions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');

if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) return [];

  // Parse header
  const header = parseCSVLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length >= header.length) {
      const row = {};
      header.forEach((h, idx) => {
        row[h.trim()] = values[idx];
      });
      rows.push(row);
    }
  }
  return rows;
}

function parseCSVLine(text) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

async function runEval() {
  const args = process.argv.slice(2);
  let limit = Infinity;
  const limitIdx = args.indexOf('--limit');
  if (limitIdx !== -1 && args[limitIdx + 1]) {
    limit = parseInt(args[limitIdx + 1], 10);
  }

  console.log(`=======================================================`);
  console.log(`📊 Evaluating Severity (Rules vs Classifier vs LLM vs Hybrid)`);
  if (limit !== Infinity) console.log(`ℹ️ Row limit applied: ${limit}`);
  console.log(`=======================================================\n`);

  const t2Path = path.join(ROOT_DIR, 'ml', 'data', 'splits', 'test_t2.csv');
  const t3Path = path.join(ROOT_DIR, 'ml', 'data', 'splits', 'test_t3.csv');

  const t2Rows = parseCSV(t2Path);
  const t3Rows = parseCSV(t3Path);

  console.log(`Loaded ${t2Rows.length} rows from test_t2.csv, ${t3Rows.length} rows from test_t3.csv.`);

  // Combine rows: evaluate on test_t2 and test_t3
  const allRows = [
    ...t2Rows.map(r => ({ ...r, split: 'test_t2', ground_truth: r.label })),
    ...t3Rows.map(r => ({ ...r, split: 'test_t3', ground_truth: r.final_label || r.label }))
  ].slice(0, limit);

  const actuals = [];
  const rulesPreds = [];
  const mlPreds = [];
  const llmPreds = [];
  const hybridPreds = [];
  let needsReviewCount = 0;

  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];
    const actual = row.ground_truth;
    actuals.push(actual);

    // 1. Rules: Note: tickets do not have logs, so affected_users and error_rate are skipped
    const rulesRes = computeRulesSeverity({
      serviceName: row.service || null,
      text: `${row.title || ''} ${row.description || ''}`
    });
    rulesPreds.push(rulesRes.severity);

    // 2. Classifier: input must be title + " " + description
    let mlLabel = 'P3';
    let isClassifierDegraded = false;
    try {
      const mlRes = await callClassifier(row.title, row.description);
      if (mlRes && mlRes.label) {
        mlLabel = mlRes.label;
      } else {
        isClassifierDegraded = true;
      }
    } catch {
      isClassifierDegraded = true;
    }
    mlPreds.push(mlLabel);

    // 3. LLM Triage (cached)
    let llmLabel = 'P3';
    try {
      const prompt = PROMPTS.triage.buildUserPrompt({
        contextBundle: {
          title: row.title,
          description: row.description,
          service: row.service
        }
      });
      const llmRes = await withLlmCache(prompt, PROMPTS.triage.system, async () => {
        const { output } = await runGeminiStage({
          stage: 'triage',
          systemPrompt: PROMPTS.triage.system,
          userPrompt: prompt,
          schema: triageSchema
        });
        return output;
      });
      if (llmRes && llmRes.severity) {
        llmLabel = llmRes.severity;
      }
    } catch (err) {
      // In case LLM fails or is unconfigured, fallback to rules
      llmLabel = rulesRes.severity;
    }
    llmPreds.push(llmLabel);

    // 4. Hybrid
    const hybridRes = combineSeverityComponents({
      rulesLevel: pToNumber(rulesRes.severity),
      classifierLevel: isClassifierDegraded ? null : pToNumber(mlLabel),
      llmLevel: pToNumber(llmLabel),
      isClassifierDegraded
    });
    hybridPreds.push(hybridRes.severity);
    if (hybridRes.needs_review) {
      needsReviewCount++;
    }

    if ((i + 1) % 25 === 0 || i === allRows.length - 1) {
      console.log(`Processed ${i + 1}/${allRows.length} items...`);
    }
  }

  // Evaluate 4 scenarios
  const scenarioResults = [];
  for (const sc of SCENARIOS) {
    const rulesRes = computeRulesSeverity({
      serviceName: sc.service,
      text: `${sc.name} ${sc.description}`
    });

    let mlLabel = 'P3';
    try {
      const mlRes = await callClassifier(sc.name, sc.description);
      if (mlRes && mlRes.label) mlLabel = mlRes.label;
    } catch {}

    const hybridRes = combineSeverityComponents({
      rulesLevel: pToNumber(rulesRes.severity),
      classifierLevel: pToNumber(mlLabel),
      llmLevel: pToNumber(sc.expectedSeverity)
    });

    scenarioResults.push({
      scenario_id: sc.id,
      name: sc.name,
      expected: sc.expectedSeverity,
      rules: rulesRes.severity,
      ml: mlLabel,
      hybrid: hybridRes.severity,
      match: hybridRes.severity === sc.expectedSeverity
    });
  }

  // Calculate metrics
  const rulesMetrics = computeClassificationMetrics(actuals, rulesPreds);
  const mlMetrics = computeClassificationMetrics(actuals, mlPreds);
  const llmMetrics = computeClassificationMetrics(actuals, llmPreds);
  const hybridMetrics = computeClassificationMetrics(actuals, hybridPreds);

  const payload = {
    metadata: {
      total_samples: allRows.length,
      t2_count: t2Rows.length,
      t3_count: t3Rows.length,
      needs_review_count: needsReviewCount,
      timestamp: new Date().toISOString()
    },
    methods: {
      rules: rulesMetrics,
      classifier: mlMetrics,
      llm: llmMetrics,
      hybrid: hybridMetrics
    },
    scenarios: scenarioResults,
    limitations: "Tickets lack real-time logs and error telemetry, so affected_users and error_rate were skipped for test_t2/test_t3."
  };

  fs.writeFileSync(path.join(RESULTS_DIR, 'severity_results.json'), JSON.stringify(payload, null, 2), 'utf8');

  // Render Markdown
  let md = `# Severity Evaluation Report\n\n`;
  md += `## 1. Overall Performance\n\n`;
  md += `| Method | Accuracy | Macro F1 | P1 F1 | P2 F1 | P3 F1 | P4 F1 |\n`;
  md += `|---|---|---|---|---|---|---|\n`;

  for (const [name, m] of Object.entries(payload.methods)) {
    md += `| **${name.toUpperCase()}** | ${(m.accuracy * 100).toFixed(1)}% | ${m.macro_f1.toFixed(3)} | ${m.per_class.P1?.f1.toFixed(3) || '0.000'} | ${m.per_class.P2?.f1.toFixed(3) || '0.000'} | ${m.per_class.P3?.f1.toFixed(3) || '0.000'} | ${m.per_class.P4?.f1.toFixed(3) || '0.000'} |\n`;
  }

  md += `\n- **Total tickets evaluated**: ${allRows.length} (test_t2: ${t2Rows.length}, test_t3: ${t3Rows.length})\n`;
  md += `- **Incidents flagged with \`needs_review: true\`**: ${needsReviewCount} (${((needsReviewCount / allRows.length) * 100).toFixed(1)}%)\n\n`;

  md += `## 2. Confusion Matrices\n\n`;
  for (const [name, m] of Object.entries(payload.methods)) {
    md += `### ${name.toUpperCase()} Confusion Matrix\n\n`;
    md += `| Actual \\ Pred | P1 | P2 | P3 | P4 |\n`;
    md += `|---|---|---|---|---|\n`;
    for (const act of ['P1', 'P2', 'P3', 'P4']) {
      md += `| **${act}** | ${m.confusion_matrix[act].P1} | ${m.confusion_matrix[act].P2} | ${m.confusion_matrix[act].P3} | ${m.confusion_matrix[act].P4} |\n`;
    }
    md += `\n`;
  }

  md += `## 3. Scenario Evaluation\n\n`;
  md += `| Scenario | Expected | Rules | ML | Hybrid | Match? |\n`;
  md += `|---|---|---|---|---|---|\n`;
  for (const s of scenarioResults) {
    md += `| ${s.name} | ${s.expected} | ${s.rules} | ${s.ml} | ${s.hybrid} | ${s.match ? '✅ YES' : '❌ NO'} |\n`;
  }

  md += `\n---\n`;
  md += `> [!NOTE]\n`;
  md += `> **Sample Size & Limitations**: ${payload.limitations} Sample size: ${allRows.length} tickets.\n`;

  fs.writeFileSync(path.join(RESULTS_DIR, 'severity_results.md'), md, 'utf8');

  console.log(`✅ Saved results to eval/results/severity_results.json and severity_results.md`);
}

runEval().catch(err => {
  console.error('Fatal eval_severity error:', err);
  process.exit(1);
});
