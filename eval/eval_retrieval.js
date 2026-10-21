import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');

if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

async function runEval() {
  console.log(`=======================================================`);
  console.log(`📊 Re-running Retrieval Evaluation (ml/eval_retrieval.py)`);
  console.log(`=======================================================\n`);

  try {
    // Run python ml/eval_retrieval.py
    execSync('python ml/eval_retrieval.py', { cwd: ROOT_DIR, stdio: 'inherit' });
  } catch (err) {
    console.error('Failed to run python ml/eval_retrieval.py:', err.message);
    process.exit(1);
  }

  // Copy resulting retrieval_results.md to eval/results/retrieval_results.md
  const sourceMd = path.join(ROOT_DIR, 'ml', 'results', 'retrieval_results.md');
  const targetMd = path.join(RESULTS_DIR, 'retrieval_results.md');

  if (fs.existsSync(sourceMd)) {
    fs.copyFileSync(sourceMd, targetMd);
    console.log(`\n✅ Copied markdown table to ${targetMd}`);
  } else {
    console.error(`❌ Source retrieval_results.md not found at ${sourceMd}`);
    process.exit(1);
  }
}

runEval().catch(err => {
  console.error('Fatal eval_retrieval error:', err);
  process.exit(1);
});
