import mongoose from 'express'; // wait, mongoose is from 'mongoose'
import mongoosePkg from 'mongoose';
const { Schema, model } = mongoosePkg;

// 1. Incidents
const incidentSchema = new Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  status: {
    type: String,
    enum: ['detected', 'processing', 'review', 'resolved', 'failed'],
    default: 'detected',
    index: true
  },
  severity: {
    type: String,
    enum: ['P1', 'P2', 'P3', 'P4', null],
    default: null
  },
  affected_systems: [{ type: String }],
  assigned_team: { type: String, default: null },
  confidence: { type: Number, default: null },
  fingerprint: { type: String, default: null, index: true },
  sources: [{ type: String }],
  affected_users: { type: Schema.Types.Mixed, default: null },
  needs_review: { type: Boolean, default: true },
  error_message: { type: String, default: null },
  created_at: { type: Date, default: Date.now, index: true },
  resolved_at: { type: Date, default: null }
});

// 2. Artifacts
const artifactSchema = new Schema({
  incident_id: { type: Schema.Types.ObjectId, ref: 'Incident', required: true, index: true },
  kind: {
    type: String,
    enum: ['log', 'screenshot', 'voice', 'email', 'report', 'text'],
    required: true
  },
  file_ref: { type: String, default: null },
  source: { type: String, default: 'user_submission' },
  received_at: { type: Date, default: Date.now }
});

// 3. Evidence
const evidenceSchema = new Schema({
  incident_id: { type: Schema.Types.ObjectId, ref: 'Incident', required: true, index: true },
  artifact_id: { type: Schema.Types.ObjectId, ref: 'Artifact', default: null },
  source: { type: String, required: true },
  type: { type: String, required: true },
  summary: { type: String, required: true },
  entities: [{ type: String }],
  errors: [{ type: String }],
  timestamps: [{ type: String }],
  confidence: { type: Number, default: 1.0 },
  status: { type: String, default: 'success' }
}, { suppressReservedKeysWarning: true });

// 4. Analyses
const analysisSchema = new Schema({
  incident_id: { type: Schema.Types.ObjectId, ref: 'Incident', required: true, index: true },
  stage: { type: String, required: true, index: true },
  output: { type: Schema.Types.Mixed, required: true },
  model: { type: String, default: null },
  prompt_version: { type: String, default: null },
  latency_ms: { type: Number, default: 0 },
  created_at: { type: Date, default: Date.now }
});

// 5. Knowledge Base
const knowledgeBaseSchema = new Schema({
  text: { type: String, required: true },
  embedding: [{ type: Number }],
  metadata: {
    service: { type: String },
    category: { type: String },
    priority: { type: String }
  },
  source: {
    type: String,
    enum: ['kaggle', 'runbook', 'synthetic', 'resolved'],
    required: true
  },
  confirmed: { type: Boolean, default: false },
  incident_id: { type: Schema.Types.ObjectId, ref: 'Incident', default: null }
});

// 6. Teams
const teamSchema = new Schema({
  name: { type: String, required: true, unique: true },
  owned_systems: [{ type: String }],
  contact: { type: String, required: true }
});

// 7. Reviews
const reviewSchema = new Schema({
  incident_id: { type: Schema.Types.ObjectId, ref: 'Incident', required: true, index: true },
  engineer: { type: String, required: true },
  changes: { type: Schema.Types.Mixed, default: {} },
  decision: { type: String, required: true },
  created_at: { type: Date, default: Date.now }
});

export const Incident = mongoosePkg.models.Incident || model('Incident', incidentSchema);
export const Artifact = mongoosePkg.models.Artifact || model('Artifact', artifactSchema);
export const Evidence = mongoosePkg.models.Evidence || model('Evidence', evidenceSchema);
export const Analysis = mongoosePkg.models.Analysis || model('Analysis', analysisSchema);
export const KnowledgeBase = mongoosePkg.models.KnowledgeBase || model('KnowledgeBase', knowledgeBaseSchema);
export const Team = mongoosePkg.models.Team || model('Team', teamSchema);
export const Review = mongoosePkg.models.Review || model('Review', reviewSchema);

export const SEED_TEAMS = [
  {
    name: 'Backend',
    owned_systems: ['api-gateway', 'course-service', 'lms-core', 'enrollment', 'api', 'server', 'course-page'],
    contact: 'backend-oncall@incidentiq.local'
  },
  {
    name: 'File Service',
    owned_systems: ['file-upload', 's3-storage', 'assignment-upload', 'media-storage', 'upload-service', 'storage'],
    contact: 'files-oncall@incidentiq.local'
  },
  {
    name: 'Auth',
    owned_systems: ['oauth', 'session-service', 'auth0', 'user-directory', 'login', 'authentication', 'rbac'],
    contact: 'auth-oncall@incidentiq.local'
  },
  {
    name: 'Database',
    owned_systems: ['mongodb', 'postgres', 'redis-cache', 'db-replica', 'database', 'sql'],
    contact: 'db-oncall@incidentiq.local'
  }
];

export async function seedTeamsIfEmpty() {
  const count = await Team.countDocuments();
  if (count === 0) {
    await Team.insertMany(SEED_TEAMS);
    console.log('[Database] Seeded 4 default teams (Backend, File Service, Auth, Database).');
  }
}
