import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let memoryServer = null;
let savedUri = null;

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  role: { type: String, default: 'student' }
});

const courseSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  instructor: { type: String, required: true }
});

const submissionSchema = new mongoose.Schema({
  courseCode: { type: String, required: true },
  studentName: { type: String, required: true },
  content: { type: String, required: true },
  submittedAt: { type: Date, default: Date.now }
});

export const User = mongoose.models.LmsUser || mongoose.model('LmsUser', userSchema);
export const Course = mongoose.models.LmsCourse || mongoose.model('LmsCourse', courseSchema);
export const Submission = mongoose.models.LmsSubmission || mongoose.model('LmsSubmission', submissionSchema);

export async function connectLmsDB(customUri) {
  const uri = customUri || process.env.DEMO_LMS_MONGO_URI;

  if (uri) {
    try {
      console.log(`[Demo-LMS DB] Connecting to external URI: ${uri}...`);
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000, dbName: 'demo_lms' });
      savedUri = uri;
      console.log('[Demo-LMS DB] Connected successfully.');
      await seedLmsData();
      return mongoose.connection;
    } catch (err) {
      console.warn(`[Demo-LMS DB] Could not connect to configured DEMO_LMS_MONGO_URI: ${err.message}`);
      console.log('[Demo-LMS DB] Falling back to embedded MongoMemoryServer...');
    }
  }

  if (!memoryServer) {
    memoryServer = await MongoMemoryServer.create({
      instance: { dbName: 'demo_lms' }
    });
  }
  savedUri = memoryServer.getUri();
  console.log(`[Demo-LMS DB] In-memory MongoDB starting at ${savedUri}`);
  await mongoose.connect(savedUri, { dbName: 'demo_lms' });
  console.log('[Demo-LMS DB] In-memory database connected.');
  await seedLmsData();
  return mongoose.connection;
}

export async function reconnectLmsDB() {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }
  const uri = savedUri || process.env.DEMO_LMS_MONGO_URI;
  if (uri) {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 4000, dbName: 'demo_lms' });
    console.log('[Demo-LMS DB] Reconnected successfully.');
    return mongoose.connection;
  }
  return await connectLmsDB();
}

export async function closeLmsDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close(false);
    console.log('[Demo-LMS DB] Connection deliberately closed (fault simulation).');
  }
}

export async function disconnectLmsDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

async function seedLmsData() {
  try {
    const userCount = await User.countDocuments();
    if (userCount === 0) {
      await User.insertMany([
        { username: 'student1', password: 'password123', name: 'Alex Rivera', role: 'student' },
        { username: 'student2', password: 'password123', name: 'Jordan Patel', role: 'student' },
        { username: 'instructor1', password: 'password123', name: 'Dr. Evelyn Reed', role: 'instructor' }
      ]);
      console.log('[Demo-LMS DB] Seeded initial users.');
    }

    const courseCount = await Course.countDocuments();
    if (courseCount === 0) {
      await Course.insertMany([
        { code: 'CS-101', title: 'Introduction to Computer Systems', instructor: 'Dr. Evelyn Reed' },
        { code: 'DS-201', title: 'Data Structures and Algorithms', instructor: 'Prof. Marcus Chen' },
        { code: 'NET-301', title: 'Distributed Systems and Cloud Architecture', instructor: 'Dr. Sarah Connor' }
      ]);
      console.log('[Demo-LMS DB] Seeded initial courses.');
    }
  } catch (err) {
    console.warn('[Demo-LMS DB] Seeding warning:', err.message);
  }
}
