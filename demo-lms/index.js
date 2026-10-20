import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config({ path: path.join(__dirname, '.env') });

import { createLmsApp } from './app.js';
import { connectLmsDB } from './db.js';

const PORT = Number(process.env.DEMO_LMS_PORT) || 4100;

async function startLms() {
  try {
    await connectLmsDB();
    const app = createLmsApp();

    const server = app.listen(PORT, () => {
      console.log(`====================================================`);
      console.log(`🎓 Demo-LMS Service running on http://localhost:${PORT}`);
      console.log(`📝 Logs writing to: demo-lms/logs/app.log`);
      console.log(`🔐 Fault Key: ${process.env.FAULT_KEY ? 'CONFIGURED' : 'DEFAULT (demo-fault-secret-key)'}`);
      console.log(`====================================================`);
    });

    return { server, app };
  } catch (err) {
    console.error('[Demo-LMS] Failed to start LMS application:', err);
    process.exit(1);
  }
}

if (process.argv[1] === __filename) {
  startLms();
}

export { startLms };
