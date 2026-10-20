import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { User, Course, Submission, closeLmsDB, reconnectLmsDB } from './db.js';
import { responseStatusReporter, errorReporter } from '../collectors/errorReporter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createLmsApp() {
  const app = express();
  const logDir = path.join(__dirname, 'logs');
  const logPath = path.join(logDir, 'app.log');

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // Fault state kept in memory
  const faultState = {
    dbDown: false,
    uploadError: false,
    slowLogin: false
  };

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Identify user from header, cookie, body, or session
  app.use((req, res, next) => {
    // If it's a monitoring probe, flag as probe and do not assign user id
    if (req.headers['x-incidentiq-probe'] === '1' || req.headers['x-incidentiq-probe'] === 1) {
      req.userRole = 'probe';
      return next();
    }

    let uid = req.headers['x-user-id'] || req.query?.user_id || req.body?.username || req.body?.studentName;

    if (!uid && req.headers.cookie) {
      const match = req.headers.cookie.match(/(?:^|;\s*)user_id=([^;]+)/);
      if (match) uid = decodeURIComponent(match[1]);
    }

    // Default simulated student user session for non-probe visitors
    if (!uid) {
      uid = 'student_demo_1';
    }

    req.userId = uid;
    next();
  });

  // Attach error reporter response hook for 5xx monitoring
  app.use(responseStatusReporter);

  // Request logger middleware: write consistent single-line logs to demo-lms/logs/app.log
  // Format: 2026-10-20T10:42:11.123Z ERROR POST /upload 500 12ms msg="MongoNotConnectedError: ..."
  app.use((req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      const status = res.statusCode;
      const level = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
      const msg = res._logMessage || res.statusMessage || (status >= 500 ? 'Internal Server Error' : 'OK');
      const escapedMsg = String(msg).replace(/"/g, '\\"').replace(/\r?\n/g, ' ');

      const logLine = `${new Date().toISOString()} ${level} ${req.method} ${req.originalUrl || req.url} ${status} ${duration}ms msg="${escapedMsg}"\n`;

      try {
        fs.appendFileSync(logPath, logLine, 'utf8');
      } catch (logErr) {
        console.error('[Demo-LMS] Failed to write log line:', logErr.message);
      }
    });

    next();
  });

  // --- Fault Injection Auth Middleware ---
  const requireFaultAuth = (req, res, next) => {
    const faultKey = req.headers['x-fault-key'];
    const expectedKey = process.env.FAULT_KEY || 'demo-fault-secret-key';

    if (!faultKey || faultKey !== expectedKey) {
      return res.status(401).json({
        error: 'Unauthorized: Missing or invalid X-Fault-Key header'
      });
    }
    next();
  };

  // --- Fault Injection Endpoints ---
  app.post('/fault/db-down', requireFaultAuth, async (req, res) => {
    faultState.dbDown = true;
    await closeLmsDB();
    res.json({
      status: 'ok',
      fault: 'db-down',
      message: 'Database connection closed and database-down fault active.'
    });
  });

  app.post('/fault/upload-error', requireFaultAuth, (req, res) => {
    faultState.uploadError = true;
    res.json({
      status: 'ok',
      fault: 'upload-error',
      message: 'Upload error fault active. Subsequent assignment uploads will throw.'
    });
  });

  app.post('/fault/slow-login', requireFaultAuth, (req, res) => {
    faultState.slowLogin = true;
    const delay = Number(process.env.FAULT_SLOW_MS) || 4000;
    res.json({
      status: 'ok',
      fault: 'slow-login',
      delay_ms: delay,
      message: `Slow login fault active. Login requests will be delayed by ${delay}ms.`
    });
  });

  app.post('/fault/reset', requireFaultAuth, async (req, res) => {
    faultState.dbDown = false;
    faultState.uploadError = false;
    faultState.slowLogin = false;
    await reconnectLmsDB();
    res.json({
      status: 'ok',
      message: 'All faults reset and database reconnected.'
    });
  });

  // Health / State Endpoint
  app.get('/health', (req, res) => {
    res.json({
      service: 'demo-lms',
      status: faultState.dbDown ? 'degraded' : 'healthy',
      faults: faultState
    });
  });

  // --- Application Routes (All backed by DB) ---

  // Portal Home
  app.get('/', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Demo LMS Portal</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; }
          .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; max-width: 600px; margin: 0 auto; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); }
          h1 { color: #38bdf8; margin-top: 0; }
          ul { list-style: none; padding: 0; }
          li { margin: 1rem 0; }
          a { color: #818cf8; text-decoration: none; font-size: 1.1rem; }
          a:hover { text-decoration: underline; }
          .badge { display: inline-block; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.8rem; background: #334155; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>🎓 University Demo LMS</h1>
          <p>Mock learning management system integrated with IncidentIQ autonomous telemetry.</p>
          <ul>
            <li><a href="/login">🔑 Student / Instructor Login</a></li>
            <li><a href="/courses">📚 Course Directory (DB-backed)</a></li>
            <li><a href="/upload">📤 Assignment Submission Upload (DB-backed)</a></li>
          </ul>
        </div>
      </body>
      </html>
    `);
  });

  // Login Page (GET)
  app.get('/login', async (req, res, next) => {
    try {
      if (faultState.slowLogin) {
        const delay = Number(process.env.FAULT_SLOW_MS) || 4000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      // Simple DB check to ensure DB connectivity
      await User.findOne();

      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Demo LMS - Login</title>
          <style>
            body { font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; }
            .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; max-width: 400px; margin: 0 auto; }
            input { width: 100%; box-sizing: border-box; padding: 0.5rem; margin: 0.5rem 0 1rem; border-radius: 4px; border: 1px solid #475569; background: #0f172a; color: white; }
            button { width: 100%; padding: 0.75rem; background: #6366f1; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; }
            button:hover { background: #4f46e5; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>Sign In to LMS</h2>
            <form method="POST" action="/login">
              <label>Username (e.g. student1)</label>
              <input type="text" name="username" value="student1" required />
              <label>Password</label>
              <input type="password" name="password" value="password123" required />
              <button type="submit">Log In</button>
            </form>
          </div>
        </body>
        </html>
      `);
    } catch (err) {
      res._logMessage = err.message;
      next(err);
    }
  });

  // Login Handler (POST)
  app.post('/login', async (req, res, next) => {
    try {
      if (faultState.slowLogin) {
        const delay = Number(process.env.FAULT_SLOW_MS) || 4000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const { username, password } = req.body;
      const user = await User.findOne({ username, password });

      if (!user) {
        res.status(401);
        res._logMessage = 'Invalid credentials';
        return res.send('<h3>Login Failed: Invalid username or password</h3><a href="/login">Try again</a>');
      }

      res.send(`<h3>Welcome, ${user.name} (${user.role})!</h3><p><a href="/courses">Go to Courses</a></p>`);
    } catch (err) {
      res._logMessage = err.message;
      next(err);
    }
  });

  // Courses List Page (GET)
  app.get('/courses', async (req, res, next) => {
    try {
      // Query courses from DB
      const courses = await Course.find();

      const items = courses
        .map(
          (c) =>
            `<li style="padding:0.75rem; background:#334155; margin:0.5rem 0; border-radius:4px;">
              <strong>${c.code}</strong>: ${c.title} <em>(Instructor: ${c.instructor})</em>
            </li>`
        )
        .join('');

      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Course Catalog</title>
          <style>
            body { font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; }
            .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; max-width: 600px; margin: 0 auto; }
            ul { list-style: none; padding: 0; }
            a { color: #818cf8; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>Course Catalog</h2>
            <ul>${items}</ul>
            <p><a href="/">Back to Home</a> | <a href="/upload">Upload Assignment</a></p>
          </div>
        </body>
        </html>
      `);
    } catch (err) {
      res._logMessage = err.message;
      next(err);
    }
  });

  // Upload Assignment Page (GET)
  app.get('/upload', async (req, res, next) => {
    try {
      // DB check
      const courses = await Course.find();

      const options = courses.map((c) => `<option value="${c.code}">${c.code} - ${c.title}</option>`).join('');

      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Assignment Upload</title>
          <style>
            body { font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; }
            .card { background: #1e293b; border-radius: 8px; padding: 1.5rem; max-width: 500px; margin: 0 auto; }
            input, select, textarea { width: 100%; box-sizing: border-box; padding: 0.5rem; margin: 0.5rem 0 1rem; border-radius: 4px; border: 1px solid #475569; background: #0f172a; color: white; }
            button { width: 100%; padding: 0.75rem; background: #10b981; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; }
            button:hover { background: #059669; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>Submit Assignment</h2>
            <form method="POST" action="/upload">
              <label>Course</label>
              <select name="courseCode">${options}</select>
              <label>Student Name</label>
              <input type="text" name="studentName" value="Alex Rivera" required />
              <label>Submission Text / File Content</label>
              <textarea name="content" rows="4" placeholder="Enter assignment solution or project notes...">Lab 3 Implementation completed.</textarea>
              <button type="submit">Submit Assignment</button>
            </form>
          </div>
        </body>
        </html>
      `);
    } catch (err) {
      res._logMessage = err.message;
      next(err);
    }
  });

  // Upload Assignment Handler (POST)
  app.post('/upload', async (req, res, next) => {
    try {
      // Check fault injection for upload-error
      if (faultState.uploadError) {
        throw new Error('UploadServiceFailure: Failed to allocate attachment buffer on storage worker');
      }

      const { courseCode = 'CS-101', studentName = 'Alex Rivera', content = 'Solution' } = req.body;

      // DB-backed save
      const submission = await Submission.create({
        courseCode,
        studentName,
        content
      });

      res.send(`<h3>Submission Received!</h3><p>ID: ${submission._id}</p><p><a href="/upload">Submit Another</a></p>`);
    } catch (err) {
      res._logMessage = err.message;
      next(err);
    }
  });

  // Custom Error-handling middleware with errorReporter
  app.use(errorReporter);

  // Catch-all 500 responder
  app.use((err, req, res, next) => {
    const status = res.statusCode >= 500 ? res.statusCode : 500;
    res.status(status);
    res._logMessage = err?.message || 'Internal Server Error';

    if (req.accepts('html')) {
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>500 - Server Error</title></head>
        <body style="font-family:sans-serif; background:#0f172a; color:#f87171; padding:2rem;">
          <h2>500 Internal Server Error</h2>
          <p><strong>Error:</strong> ${err?.message || 'Unexpected failure'}</p>
          <pre style="background:#1e293b; padding:1rem; border-radius:4px; color:#cbd5e1; overflow-x:auto;">${err?.stack || ''}</pre>
          <p><a href="/" style="color:#818cf8;">Back to Home</a></p>
        </body>
        </html>
      `);
    } else {
      res.json({
        error: err?.message || 'Internal Server Error',
        stack: err?.stack
      });
    }
  });

  return app;
}
