import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let memoryServer = null;

export async function connectDB(uri) {
  const mongoUri = uri || process.env.MONGODB_URI;

  if (mongoUri) {
    try {
      console.log(`[Database] Attempting connection to ${mongoUri.replace(/:([^:@]{3})[^:@]*@/, ':***@')}...`);
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 4000 });
      console.log('[Database] Connected to external MongoDB successfully.');
      return mongoose.connection;
    } catch (err) {
      console.warn(`[Database] Could not connect to configured MONGODB_URI: ${err.message}`);
      console.log('[Database] Falling back to embedded MongoMemoryServer for development/testing...');
    }
  }

  // Fallback to in-memory MongoDB
  if (!memoryServer) {
    memoryServer = await MongoMemoryServer.create();
  }
  const inMemoryUri = memoryServer.getUri();
  console.log(`[Database] Starting in-memory MongoDB at ${inMemoryUri}`);
  await mongoose.connect(inMemoryUri);
  console.log('[Database] Connected to in-memory MongoDB successfully.');
  return mongoose.connection;
}

export async function disconnectDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}
