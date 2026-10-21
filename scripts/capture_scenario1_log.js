import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createLmsApp } from '../demo-lms/app.js';
import { connectLmsDB, disconnectLmsDB } from '../demo-lms/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function captureRealLog() {
  const logDir = path.join(__dirname, '..', 'demo-lms', 'logs');
  const logPath = path.join(logDir, 'app.log');
  const targetPath = path.join(__dirname, '..', 'fixtures', 'scenario1', 'demo_lms.log');

  // Clear previous log
  if (fs.existsSync(logPath)) {
    fs.unlinkSync(logPath);
  }

  const FAULT_KEY = 'demo-fault-secret-key';
  process.env.FAULT_KEY = FAULT_KEY;

  console.log('[CaptureLog] Connecting to LMS database...');
  await connectLmsDB();
  const app = createLmsApp();

  try {
    // 1. Send some healthy traffic
    console.log('[CaptureLog] Generating initial healthy traffic...');
    await request(app).get('/courses').expect(200);
    await request(app).get('/upload').expect(200);
    await request(app).post('/login').send({ username: 'student1', password: 'password123' }).expect(200);

    // 2. Inject db-down fault
    console.log('[CaptureLog] Injecting db-down fault...');
    await request(app)
      .post('/fault/db-down')
      .set('X-Fault-Key', FAULT_KEY)
      .expect(200);

    // 3. Generate repeated requests that fail due to DB down
    console.log('[CaptureLog] Generating DB-down failure traffic...');
    for (let i = 0; i < 15; i++) {
      await request(app).get('/courses').expect(500);
      await request(app).post('/upload').send({
        courseCode: 'CS-101',
        studentName: `student_${i + 1}`,
        content: 'Project submission code'
      }).expect(500);
      await request(app).post('/login').send({
        username: `student_${i + 1}`,
        password: 'password123'
      }).expect(500);
    }

    // 4. Recover DB
    console.log('[CaptureLog] Recovering database connection...');
    await request(app)
      .post('/fault/reset')
      .set('X-Fault-Key', FAULT_KEY)
      .expect(200);

    // Read captured log
    const content = fs.readFileSync(logPath, 'utf8');
    fs.writeFileSync(targetPath, content, 'utf8');
    console.log(`[CaptureLog] Successfully wrote real captured log to ${targetPath} (${content.split('\n').length} lines)`);
  } finally {
    await disconnectLmsDB();
  }
}

captureRealLog().catch(err => {
  console.error('[CaptureLog] Failed:', err);
  process.exit(1);
});
