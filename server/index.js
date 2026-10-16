import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables from server/.env, parent .env, or fallback
dotenv.config({ path: path.join(__dirname, '.env') });
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { createApp } from './app.js';
import { connectDB } from './db/connection.js';
import { seedTeamsIfEmpty } from './models/index.js';
import { setSocketIO } from './pipeline.js';

const PORT = process.env.PORT || 5000;
const app = createApp();
const server = http.createServer(app);

// Initialize Socket.IO
const io = new SocketIOServer(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH']
  }
});

setSocketIO(io);

io.on('connection', (socket) => {
  console.log(`[Socket.IO] Client connected: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
  });
});

async function startServer() {
  try {
    await connectDB();
    await seedTeamsIfEmpty();

    server.listen(PORT, () => {
      console.log(`====================================================`);
      console.log(`🚀 IncidentIQ Backend Server running on port ${PORT}`);
      console.log(`📡 Socket.IO initialized for real-time telemetry`);
      console.log(`⚙️  DEMO_MODE: ${process.env.DEMO_MODE === 'true' ? 'ENABLED (serving real recorded outputs)' : 'DISABLED (live Gemini API)'}`);
      console.log(`====================================================`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Start if executed directly
if (process.argv[1] === __filename) {
  startServer();
}

export { server, app, io };
