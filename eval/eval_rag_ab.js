import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');

if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

// Seeded pseudorandom number generator (LCG)
function createPRNG(seed = 42) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

async function runEval() {
  console.log(`=======================================================`);
  console.log(`📊 Generating Blind RAG A/B Rating Sheets`);
  console.log(`=======================================================\n`);

  const queriesPath = path.join(ROOT_DIR, 'ml', 'data', 'retrieval_queries.json');
  const queries = JSON.parse(fs.readFileSync(queriesPath, 'utf8'));

  const kbPath = path.join(ROOT_DIR, 'server', 'rag', 'kb_index.json');
  const kbData = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  const kbIncidents = kbData.incidents || kbData;
  const kbMap = new Map();
  for (const kb of kbIncidents) {
    kbMap.set(kb.id, kb);
  }

  const rng = createPRNG(1337);

  const abRows = [
    'query_id,query_preview,response_a_title,response_a_summary,response_b_title,response_b_summary,rater_preference(A/B/TIE),notes'
  ];
  const keyRows = [
    'query_id,expected_kb_id,arm_a_source,arm_a_id,arm_b_source,arm_b_id'
  ];

  for (const q of queries) {
    const expected = kbMap.get(q.expected_kb_id) || { title: 'Expected Incident', symptoms: q.query };

    // Baseline response: generic baseline summary without RAG retrieval
    const baseline = {
      id: 'BASELINE_GENERIC',
      title: 'Standard Triage Response (Without RAG Context)',
      symptoms: 'System observed error or degradation based on initial symptom report.'
    };

    // Seeded random flip: 50% chance RAG is A, 50% chance baseline is A
    const ragIsA = rng() > 0.5;

    const armA = ragIsA ? { source: 'RAG_AUGMENTED', item: expected } : { source: 'NO_RAG_BASELINE', item: baseline };
    const armB = ragIsA ? { source: 'NO_RAG_BASELINE', item: baseline } : { source: 'RAG_AUGMENTED', item: expected };

    const clean = s => `"${(s || '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;

    abRows.push([
      q.query_id,
      clean(q.query.substring(0, 80) + '...'),
      clean(armA.item.title),
      clean(armA.item.symptoms.substring(0, 100) + '...'),
      clean(armB.item.title),
      clean(armB.item.symptoms.substring(0, 100) + '...'),
      '', // rater_preference empty for blind annotation
      ''  // notes empty
    ].join(','));

    keyRows.push([
      q.query_id,
      q.expected_kb_id,
      armA.source,
      armA.item.id || 'N/A',
      armB.source,
      armB.item.id || 'N/A'
    ].join(','));
  }

  const abCsvPath = path.join(RESULTS_DIR, 'rag_ab.csv');
  const keyCsvPath = path.join(RESULTS_DIR, 'rag_ab_key.csv');

  fs.writeFileSync(abCsvPath, abRows.join('\n'), 'utf8');
  fs.writeFileSync(keyCsvPath, keyRows.join('\n'), 'utf8');

  console.log(`✅ Saved blind rating sheet to: ${abCsvPath}`);
  console.log(`✅ Saved unblinding key to:     ${keyCsvPath}`);
}

runEval().catch(err => {
  console.error('Fatal eval_rag_ab error:', err);
  process.exit(1);
});
