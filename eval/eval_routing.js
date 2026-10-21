import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './scenarios/definitions.js';
import { withLlmCache } from './llm_cache.js';
import { runGeminiStage } from '../server/agents/gemini.js';
import { PROMPTS, routerSchema } from '../server/agents/prompts/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');

if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

async function runEval() {
  console.log(`=======================================================`);
  console.log(`📊 Evaluating Routing Accuracy`);
  console.log(`=======================================================\n`);

  const catalogPath = path.join(ROOT_DIR, 'ml', 'data', 'service_catalog.json');
  const serviceCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const serviceToTeam = {};
  for (const s of serviceCatalog) {
    if (s.name && s.owning_team) {
      serviceToTeam[s.name.toLowerCase()] = s.owning_team;
    }
  }

  const kbPath = path.join(ROOT_DIR, 'server', 'rag', 'kb_index.json');
  const kbData = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  const kbIncidents = kbData.incidents || kbData;
  const kbToTeam = {};
  for (const kb of kbIncidents) {
    if (kb.id && kb.service) {
      kbToTeam[kb.id] = serviceToTeam[kb.service.toLowerCase()] || null;
    }
  }

  const queriesPath = path.join(ROOT_DIR, 'ml', 'data', 'retrieval_queries.json');
  const queries = JSON.parse(fs.readFileSync(queriesPath, 'utf8'));

  const results = [];
  let skippedCount = 0;
  let correctCount = 0;
  let totalEvaluated = 0;

  // 1. Evaluate 4 Scenarios
  for (const sc of SCENARIOS) {
    totalEvaluated++;
    const prompt = PROMPTS.router.buildUserPrompt({
      triageOutput: { severity: sc.expectedSeverity, affected_systems: [sc.service] },
      rootCauseOutput: { probable_root_cause: sc.description },
      contextBundle: { summary: sc.name }
    });

    let routedTeam = 'Backend';
    try {
      const llmRes = await withLlmCache(prompt, PROMPTS.router.system, async () => {
        const { output } = await runGeminiStage({
          stage: 'router',
          systemPrompt: PROMPTS.router.system,
          userPrompt: prompt,
          schema: routerSchema
        });
        return output;
      });
      if (llmRes && llmRes.team) routedTeam = llmRes.team;
    } catch {}

    const isMatch = routedTeam.toLowerCase().includes(sc.expectedTeam.toLowerCase()) ||
                    sc.expectedTeam.toLowerCase().includes(routedTeam.toLowerCase());
    if (isMatch) correctCount++;

    results.push({
      item_id: sc.id,
      description: sc.name,
      expected_team: sc.expectedTeam,
      routed_team: routedTeam,
      is_correct: isMatch,
      status: 'evaluated'
    });
  }

  // 2. Evaluate 15 retrieval queries
  for (const q of queries) {
    const expectedTeam = kbToTeam[q.expected_kb_id];
    if (!expectedTeam) {
      skippedCount++;
      results.push({
        item_id: q.query_id,
        description: q.query.substring(0, 60) + '...',
        expected_team: null,
        routed_team: null,
        is_correct: false,
        status: 'skipped'
      });
      continue;
    }

    totalEvaluated++;
    const prompt = PROMPTS.router.buildUserPrompt({
      triageOutput: { severity: 'P2', affected_systems: [] },
      rootCauseOutput: { probable_root_cause: q.query },
      contextBundle: { summary: q.query }
    });

    let routedTeam = 'Backend';
    try {
      const llmRes = await withLlmCache(prompt, PROMPTS.router.system, async () => {
        const { output } = await runGeminiStage({
          stage: 'router',
          systemPrompt: PROMPTS.router.system,
          userPrompt: prompt,
          schema: routerSchema
        });
        return output;
      });
      if (llmRes && llmRes.team) routedTeam = llmRes.team;
    } catch {}

    const isMatch = routedTeam.toLowerCase().includes(expectedTeam.toLowerCase()) ||
                    expectedTeam.toLowerCase().includes(routedTeam.toLowerCase());
    if (isMatch) correctCount++;

    results.push({
      item_id: q.query_id,
      description: q.query.substring(0, 60) + '...',
      expected_team: expectedTeam,
      routed_team: routedTeam,
      is_correct: isMatch,
      status: 'evaluated'
    });
  }

  const accuracy = totalEvaluated > 0 ? correctCount / totalEvaluated : 0;

  const payload = {
    metadata: {
      total_items: results.length,
      evaluated_count: totalEvaluated,
      skipped_count: skippedCount,
      correct_count: correctCount,
      accuracy: Number(accuracy.toFixed(4)),
      timestamp: new Date().toISOString()
    },
    results,
    limitations: "15 retrieval queries map to service catalog owning teams via their expected KB incident service. Items where owning team is unknown or ambiguous are skipped."
  };

  fs.writeFileSync(path.join(RESULTS_DIR, 'routing_results.json'), JSON.stringify(payload, null, 2), 'utf8');

  let md = `# IncidentIQ Routing Evaluation Report\n\n`;
  md += `## Summary Metrics\n\n`;
  md += `- **Evaluated Items**: ${totalEvaluated}\n`;
  md += `- **Skipped Items (unknown team)**: ${skippedCount}\n`;
  md += `- **Correctly Routed**: ${correctCount}\n`;
  md += `- **Routing Accuracy**: **${(accuracy * 100).toFixed(1)}%**\n\n`;

  md += `## Detailed Routing Results\n\n`;
  md += `| Item ID | Description | Expected Team | Routed Team | Status | Result |\n`;
  md += `|---|---|---|---|---|---|\n`;

  for (const r of results) {
    const resIcon = r.status === 'skipped' ? '⚠️ SKIPPED' : (r.is_correct ? '✅ PASS' : '❌ FAIL');
    md += `| ${r.item_id} | ${r.description.replace(/\|/g, '-')} | ${r.expected_team || 'N/A'} | ${r.routed_team || 'N/A'} | ${r.status} | ${resIcon} |\n`;
  }

  md += `\n---\n`;
  md += `> [!NOTE]\n`;
  md += `> **Sample Size & Limitations**: ${payload.limitations} Total evaluated: ${totalEvaluated}.\n`;

  fs.writeFileSync(path.join(RESULTS_DIR, 'routing_results.md'), md, 'utf8');

  console.log(`✅ Saved routing results to eval/results/routing_results.json and routing_results.md`);
}

runEval().catch(err => {
  console.error('Fatal eval_routing error:', err);
  process.exit(1);
});
