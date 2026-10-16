import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { executePipeline } from '../pipeline.js';
import { Incident, Artifact } from '../models/index.js';
import { connectDB, disconnectDB } from '../db/connection.js';

describe('Pipeline Stage Error Handling', () => {
  before(async () => {
    await connectDB();
  });

  after(async () => {
    await disconnectDB();
  });

  test('Pipeline marks incident status as "failed" when an unexpected stage error occurs', async () => {
    // Create an incident
    const incident = await Incident.create({
      title: 'Test Incident for Error Handling',
      description: 'Will fail due to invalid text payload',
      status: 'detected'
    });

    const artifact = await Artifact.create({
      incident_id: incident._id,
      kind: 'text',
      source: 'test'
    });

    // Pass invalid text parameter (null) which triggers an error in textProcessor
    await assert.rejects(
      async () => {
        await executePipeline({
          incidentId: incident._id,
          artifactId: artifact._id,
          text: null
        });
      },
      /Invalid text content for text processor/
    );

    // Verify incident in database was marked as 'failed' with error recorded
    const updatedIncident = await Incident.findById(incident._id);
    assert.equal(updatedIncident.status, 'failed');
    assert.ok(updatedIncident.error_message.includes('Stage [text_processor] failed'));
  });
});
