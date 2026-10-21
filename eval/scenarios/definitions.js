/**
 * Canonical test scenarios for evaluation and ablation studies.
 */
export const SCENARIOS = [
  {
    id: 'scenario1',
    name: 'Scenario 1: Database Outage',
    fault: 'db-down',
    service: 'demo-lms',
    expectedTeam: 'Backend',
    expectedSeverity: 'P1',
    expectedKbId: 'KB-011',
    description: 'Postgres database connection drop causing HTTP 500 across courses and uploads.'
  },
  {
    id: 'scenario2',
    name: 'Scenario 2: Upload Service Failure',
    fault: 'upload-error',
    service: 'demo-lms',
    expectedTeam: 'File Service',
    expectedSeverity: 'P2',
    expectedKbId: 'KB-008',
    description: 'File upload storage buffer failure blocking coursework submissions.'
  },
  {
    id: 'scenario3',
    name: 'Scenario 3: Slow Login / Auth Delay',
    fault: 'slow-login',
    service: 'demo-lms',
    expectedTeam: 'Auth',
    expectedSeverity: 'P3',
    expectedKbId: 'KB-003',
    description: 'High latency in authentication flow causing login timeouts.'
  },
  {
    id: 'scenario4',
    name: 'Scenario 4: Re-occurrence with Learning Loop',
    fault: 'db-down',
    service: 'demo-lms',
    expectedTeam: 'Backend',
    expectedSeverity: 'P1',
    expectedKbId: 'CONFIRMED-SCENARIO1',
    description: 'Re-injected database connection failure matching a previously resolved and confirmed incident.'
  }
];
