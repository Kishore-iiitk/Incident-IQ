/**
 * Express error reporting middleware for demo-lms.
 * Catches unhandled exceptions and 5xx responses and asynchronously sends
 * automatic incident signals to the IncidentIQ backend.
 *
 * Guarantees:
 * - Never blocks client responses
 * - Never crashes the application if IncidentIQ is unreachable (short timeout, swallow and log)
 */

async function sendSignal(payload) {
  const incidentIqUrl = process.env.INCIDENTIQ_URL || 'http://localhost:5000/incidents';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);

    const res = await fetch(incidentIqUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    if (!res.ok) {
      console.warn(`[ErrorReporter] IncidentIQ responded with status ${res.status}`);
    }
  } catch (err) {
    // Non-blocking swallow - never crash or bubble to the host application
    console.warn(`[ErrorReporter] Failed to send error signal to IncidentIQ: ${err.message}`);
  }
}

function extractUserInfo(req) {
  const probeHeader = req.headers['x-incidentiq-probe'];
  const isProbe = probeHeader === '1' || probeHeader === 1 || req.userRole === 'probe';

  if (isProbe) {
    return {
      userRole: 'probe',
      userId: null
    };
  }

  const userRole = req.headers['x-user-role'] || req.userRole || 'student';
  const userId = req.userId ||
    req.user?.id ||
    req.user?._id ||
    req.session?.userId ||
    req.headers['x-user-id'] ||
    req.body?.username ||
    req.body?.studentName ||
    null;

  return {
    userRole,
    userId: userId ? String(userId) : null
  };
}

/**
 * Request hook middleware: monitors responses for 5xx status codes.
 */
export function responseStatusReporter(req, res, next) {
  res.on('finish', () => {
    if (res.statusCode >= 500 && !res._errorReporterHandled) {
      res._errorReporterHandled = true;
      const endpoint = req.originalUrl || req.url || req.path;
      const { userRole, userId } = extractUserInfo(req);

      const payload = {
        source: 'reporter',
        service: 'demo-lms',
        endpoint,
        status: res.statusCode,
        message: res.statusMessage || `HTTP ${res.statusCode} Internal Server Error`,
        user_role: userRole,
        user_id: userId,
        timestamp: new Date().toISOString()
      };

      // Fire and forget
      sendSignal(payload);
    }
  });

  next();
}

function sanitizeErrorMessage(msg) {
  if (!msg || typeof msg !== 'string') return '';
  return msg
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Express error-handling middleware: (err, req, res, next)
 */
export function errorReporter(err, req, res, next) {
  res._errorReporterHandled = true;
  const endpoint = req.originalUrl || req.url || req.path;
  const { userRole, userId } = extractUserInfo(req);

  const payload = {
    source: 'reporter',
    service: 'demo-lms',
    endpoint,
    status: res.statusCode >= 500 ? res.statusCode : 500,
    message: sanitizeErrorMessage(err?.message || String(err)),
    stack: err?.stack || undefined,
    user_role: userRole,
    user_id: userId,
    timestamp: new Date().toISOString()
  };

  // Fire and forget
  sendSignal(payload);

  next(err);
}

export default errorReporter;
