import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const scripts = [
  'eval/eval_retrieval.js',
  'eval/eval_severity.js',
  'eval/eval_routing.js',
  'eval/eval_dedup.js',
  'eval/eval_latency.js',
  'eval/eval_ablations.js',
  'eval/eval_rag_ab.js'
];

console.log('====================================================');
console.log('🚀 Running Complete Incident-IQ Evaluation Suite');
console.log('====================================================\n');

for (const s of scripts) {
  console.log(`\n====================================================`);
  console.log(`▶️ Executing: node ${s}`);
  console.log(`====================================================`);
  try {
    execSync(`node ${s}`, { cwd: ROOT_DIR, stdio: 'inherit' });
  } catch (err) {
    console.error(`❌ Error executing ${s}:`, err.message);
    process.exit(1);
  }
}

console.log('\n====================================================');
console.log('🎉 All evaluation scripts completed successfully!');
console.log('Results are stored in eval/results/');
console.log('====================================================\n');
