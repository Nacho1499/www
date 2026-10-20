import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SUBSCRIBE_API_SECURITY_HEADERS } from '../src/utils/security-headers';

/**
 * Vercel serverless function — not part of the Vite/tsc build (only `src` is
 * type-checked by `tsc -b`); Vercel transpiles this file independently at deploy time.
 *
 * Proxies subscribe requests to Buttondown server-side so no third-party JS or
 * API key is ever exposed to the client. Requires BUTTONDOWN_API_KEY to be set
 * in the Vercel project's environment variables.
 *
 * Provider choice: Buttondown
 *   - Open-source-friendly, privacy-respecting operator (no tracking pixels by
 *     default, GDPR-compliant hosting)
 *   - Simple REST API requiring only an API key — no client SDK needed
 *   - Supports double opt-in natively via a list toggle, not custom code
 *   - Free tier covers the initial subscriber volume; no vendor lock-in
 */

type SubscribeBody = { email?: unknown; tag?: unknown };
type SubscribeRequest = IncomingMessage;

const SUPPORTED_TAGS = new Set(['newsletter', 'careers']);
export const MAX_REQUEST_BODY_BYTES = 2048;
export const RATE_LIMIT_REQUESTS = 5;
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_RATE_LIMIT_CLIENTS = 10_000;

const rateLimitSecret = randomBytes(32);
const rateLimitBuckets = new Map<string, { windowStartedAt: number; count: number }>();
const inFlightSubmissions = new Map<string, Promise<SubscribeResult>>();
let rateLimitChecks = 0;

export const BUTTONDOWN_API_URL = 'https://api.buttondown.email/v1/subscribers';

/**
 * Bounded upstream timeout. A slow provider must never hold the function open
 * indefinitely, so every request is aborted after this window.
 */
export const UPSTREAM_TIMEOUT_MS = 5000;

// Simple email regex — we validate server-side to avoid trusting the client.
const EMAIL_RE = /^[^\s@]+@[^\s@][^@]*\.[^\s@]+$/;

/** Stable client-facing error codes. Provider details never reach the client. */
export type SubscribeErrorCode =
  | 'method_not_allowed'
  | 'not_configured'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'invalid_request'
  | 'invalid_email'
  | 'invalid_tag'
  | 'rate_limited'
  | 'upstream_timeout'
  | 'upstream_error';

const ERROR_STATUS: Record<SubscribeErrorCode, number> = {
  method_not_allowed: 405,
  not_configured: 500,
  unsupported_media_type: 415,
  payload_too_large: 413,
  invalid_request: 400,
  invalid_email: 422,
  invalid_tag: 422,
  rate_limited: 429,
  upstream_timeout: 504,
  upstream_error: 502,
};

const ERROR_MESSAGE: Record<SubscribeErrorCode, string> = {
  method_not_allowed: 'Method not allowed.',
  not_configured: 'Subscription service is not configured.',
  unsupported_media_type: 'Content-Type must be application/json.',
  payload_too_large: 'Request body must be 2,048 bytes or less.',
  invalid_request: 'Invalid request.',
  invalid_email: 'Enter a valid email address.',
  invalid_tag: 'Unsupported subscription tag.',
  rate_limited: 'Too many requests. Please try again later.',
  upstream_timeout: 'Subscription service timed out. Please try again.',
  upstream_error: 'Subscription service is unavailable.',
};

/**
 * Prefer the platform-provided request ID when present so logs correlate with
 * Vercel's own traces; otherwise mint one for this invocation.
 */
function resolveRequestId(req: SubscribeRequest): string {
  const header = req.headers['x-vercel-id'] ?? req.headers['x-request-id'];
  if (typeof header === 'string' && header.length > 0) return header;
  return randomUUID();
}

/**
 * Log request IDs and status codes only — never email addresses, tags, secrets,
 * or raw provider payloads.
 */
function logEvent(requestId: string, event: string, status: number) {
  const line = `[subscribe] event=${event} request_id=${requestId} status=${status}`;
  if (status >= 400) {
    console.error(line);
  } else {
    console.log(line);
  }
}

function sendJson(res: ServerResponse, requestId: string, status: number, payload: unknown) {
  res.statusCode = status;
  for (const [key, value] of Object.entries(SUBSCRIBE_API_SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Request-Id', requestId);
  res.end(JSON.stringify(payload));
}

function sendError(res: ServerResponse, requestId: string, code: SubscribeErrorCode) {
  sendJson(res, requestId, ERROR_STATUS[code], { error: ERROR_MESSAGE[code], code });
}

function resolveClientKey(req: SubscribeRequest): string {
  const forwardedFor = req.headers['x-vercel-forwarded-for'];
  const clientIp = typeof forwardedFor === 'string' ? forwardedFor.trim() : '';
  const trustedIp = isIP(clientIp) ? clientIp : 'unknown';
  return createHmac('sha256', rateLimitSecret).update(trustedIp).digest('hex');
}

function checkRateLimit(clientKey: string, now = Date.now()): number | null {
  rateLimitChecks += 1;
  if (rateLimitChecks % 100 === 0 || rateLimitBuckets.size >= MAX_RATE_LIMIT_CLIENTS) {
    for (const [key, bucket] of rateLimitBuckets) {
      if (now - bucket.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
        rateLimitBuckets.delete(key);
      }
    }
  }

  const bucket = rateLimitBuckets.get(clientKey);
  if (!bucket || now - bucket.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    if (rateLimitBuckets.size >= MAX_RATE_LIMIT_CLIENTS) {
      return Math.ceil(RATE_LIMIT_WINDOW_MS / 1000);
    }
    rateLimitBuckets.set(clientKey, { windowStartedAt: now, count: 1 });
    return null;
  }

  if (bucket.count >= RATE_LIMIT_REQUESTS) {
    return Math.max(1, Math.ceil((bucket.windowStartedAt + RATE_LIMIT_WINDOW_MS - now) / 1000));
  }

  bucket.count += 1;
  return null;
}

type SubscribeResult = { status: number; payload: unknown };

function isSubscribeBody(value: unknown): value is SubscribeBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type RawBodyResult = { kind: 'ok'; text: string } | { kind: 'too_large' } | { kind: 'error' };

/**
 * Reads the raw request bytes and stops as soon as `limit` is crossed, before
 * any JSON parsing happens. Counting raw bytes covers whitespace padding and
 * chunked transfer encoding, which a post-parse size check cannot see.
 * `req.body` is deliberately never touched: on Vercel it is a lazy getter that
 * would buffer and parse the whole stream first.
 */
function readRawBody(req: SubscribeRequest, limit: number): Promise<RawBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const finish = (result: RawBodyResult) => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onError);
      resolve(result);
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      received += buffer.byteLength;
      if (received > limit) {
        chunks.length = 0;
        req.pause();
        finish({ kind: 'too_large' });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => finish({ kind: 'ok', text: Buffer.concat(chunks).toString('utf8') });
    const onError = () => finish({ kind: 'error' });

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onError);
  });
}

async function submitToProvider(
  rawEmail: string,
  tag: string,
  apiKey: string,
  requestId: string,
): Promise<SubscribeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const bdRes = await fetch(BUTTONDOWN_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: rawEmail, tags: [tag], type: 'unconfirmed' }),
      signal: controller.signal,
    });

    if (bdRes.status === 201 || bdRes.status === 409) {
      logEvent(requestId, 'subscribed', 201);
      return { status: 201, payload: { ok: true } };
    }

    if (bdRes.status === 400 || bdRes.status === 422) {
      let code: unknown;
      try {
        const body = (await bdRes.json()) as Record<string, unknown> | null;
        code = body?.code;
      } catch {
        code = undefined;
      }

      if (code === 'email_already_exists' || code === 'subscriber_already_exists') {
        logEvent(requestId, 'subscribed', 201);
        return { status: 201, payload: { ok: true } };
      }

      logEvent(requestId, 'invalid_email', 422);
      return {
        status: 422,
        payload: { error: ERROR_MESSAGE.invalid_email, code: 'invalid_email' },
      };
    }

    logEvent(requestId, 'upstream_error', bdRes.status);
    return {
      status: 502,
      payload: { error: ERROR_MESSAGE.upstream_error, code: 'upstream_error' },
    };
  } catch {
    if (controller.signal.aborted) {
      logEvent(requestId, 'upstream_timeout', 504);
      return {
        status: 504,
        payload: { error: ERROR_MESSAGE.upstream_timeout, code: 'upstream_timeout' },
      };
    }

    logEvent(requestId, 'upstream_error', 502);
    return {
      status: 502,
      payload: { error: ERROR_MESSAGE.upstream_error, code: 'upstream_error' },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req: SubscribeRequest, res: ServerResponse) {
  const requestId = resolveRequestId(req);

  if (req.method !== 'POST') {
    logEvent(requestId, 'method_not_allowed', 405);
    sendError(res, requestId, 'method_not_allowed');
    return;
  }

  const apiKey = process.env.BUTTONDOWN_API_KEY;
  if (!apiKey) {
    logEvent(requestId, 'not_configured', 500);
    sendError(res, requestId, 'not_configured');
    return;
  }

  const contentType = req.headers['content-type'];
  const mediaType = typeof contentType === 'string' ? contentType.split(';', 1)[0]?.trim() : '';
  if (mediaType?.toLowerCase() !== 'application/json') {
    logEvent(requestId, 'unsupported_media_type', 415);
    sendError(res, requestId, 'unsupported_media_type');
    return;
  }

  const declaredLength = req.headers['content-length'];
  if (
    declaredLength !== undefined &&
    (typeof declaredLength !== 'string' || !/^\d+$/.test(declaredLength))
  ) {
    logEvent(requestId, 'invalid_request', 400);
    sendError(res, requestId, 'invalid_request');
    return;
  }

  if (declaredLength !== undefined && Number(declaredLength) > MAX_REQUEST_BODY_BYTES) {
    logEvent(requestId, 'payload_too_large', 413);
    sendError(res, requestId, 'payload_too_large');
    return;
  }

  const rawBody = await readRawBody(req, MAX_REQUEST_BODY_BYTES);
  if (rawBody.kind === 'too_large') {
    logEvent(requestId, 'payload_too_large', 413);
    res.setHeader('Connection', 'close');
    sendError(res, requestId, 'payload_too_large');
    return;
  }
  if (rawBody.kind === 'error') {
    logEvent(requestId, 'invalid_request', 400);
    sendError(res, requestId, 'invalid_request');
    return;
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody.text);
  } catch {
    logEvent(requestId, 'invalid_request', 400);
    sendError(res, requestId, 'invalid_request');
    return;
  }

  const body = isSubscribeBody(parsedBody) ? parsedBody : {};
  const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const tag =
    body.tag === undefined ? 'newsletter' : typeof body.tag === 'string' ? body.tag.trim() : '';

  if (!rawEmail || !EMAIL_RE.test(rawEmail)) {
    logEvent(requestId, 'invalid_email', 422);
    sendError(res, requestId, 'invalid_email');
    return;
  }

  if (!SUPPORTED_TAGS.has(tag)) {
    logEvent(requestId, 'invalid_tag', 422);
    sendError(res, requestId, 'invalid_tag');
    return;
  }

  const retryAfter = checkRateLimit(resolveClientKey(req));
  if (retryAfter !== null) {
    logEvent(requestId, 'rate_limited', 429);
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, requestId, 429, {
      error: ERROR_MESSAGE.rate_limited,
      code: 'rate_limited',
      retryAfter,
    });
    return;
  }

  let submission = inFlightSubmissions.get(rawEmail);
  if (!submission) {
    submission = submitToProvider(rawEmail, tag, apiKey, requestId);
    inFlightSubmissions.set(rawEmail, submission);
    const clearSubmission = () => {
      if (inFlightSubmissions.get(rawEmail) === submission) {
        inFlightSubmissions.delete(rawEmail);
      }
    };
    void submission.then(clearSubmission, clearSubmission);
  }

  const result = await submission;
  sendJson(res, requestId, result.status, result.payload);
}
