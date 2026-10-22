/**
 * IncidentIQ API Client Helper Module.
 * Unified API base setting via VITE_API_URL (default http://localhost:5000).
 * All UI network calls route through this module.
 */

export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000';

/**
 * Universal fetch wrapper that ensures every request URL is prefixed with API_BASE,
 * and errors explicitly name the failing request (e.g. "POST /incidents returned 404").
 */
export async function apiFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const method = (options.method || 'GET').toUpperCase();

  let response;
  try {
    response = await fetch(url, options);
  } catch (netErr) {
    throw new Error(`${method} ${path} failed: ${netErr.message}`);
  }

  if (!response.ok) {
    let serverMessage = '';
    try {
      const data = await response.json();
      serverMessage = data.error || data.message || '';
    } catch {
      // response is not JSON
    }

    const detail = serverMessage ? `: ${serverMessage}` : '';
    throw new Error(`${method} ${path} returned ${response.status}${detail}`);
  }

  // 204 No Content
  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await response.json();
  }

  return await response.text();
}

/**
 * Health check endpoint
 */
export async function getHealth() {
  return await apiFetch('/health');
}

/**
 * List all incidents
 */
export async function getIncidents() {
  return await apiFetch('/incidents');
}

/**
 * Get incident detail by ID (includes evidence, analyses, artifacts, reviews)
 */
export async function getIncident(id) {
  return await apiFetch(`/incidents/${id}`);
}

/**
 * Create incident (accepts JSON object or multipart FormData)
 */
export async function createIncident(body, isMultipart = false) {
  const options = {
    method: 'POST',
    body: isMultipart ? body : JSON.stringify(body)
  };

  if (!isMultipart) {
    options.headers = { 'Content-Type': 'application/json' };
  }

  return await apiFetch('/incidents', options);
}

/**
 * Save human review action (approve or edit)
 */
export async function reviewIncident(id, { field, action, new_value, reviewer = 'oncall_engineer' }) {
  return await apiFetch(`/incidents/${id}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ field, action, new_value, reviewer })
  });
}

/**
 * Mark incident as resolved
 */
export async function resolveIncident(id, { root_cause, resolution, symptoms = '' }) {
  return await apiFetch(`/incidents/${id}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root_cause, resolution, symptoms })
  });
}

/**
 * Retry failed incident pipeline analysis (POST /incidents/:id/retry)
 */
export async function retryIncident(id) {
  return await apiFetch(`/incidents/${id}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
}
