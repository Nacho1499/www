import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

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
type SubscribeRequest = IncomingMessage & { body?: unknown };

const BUTTONDOWN_API_URL = 'https://api.buttondown.email/v1/subscribers';
// Simple email regex — we validate server-side to avoid trusting the client.
const EMAIL_RE = /^[^\s@]+@[^\s@][^@]*\.[^\s@]+$/;
const MAX_BODY_BYTES = 1024;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const DEDUPE_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_KEYS = 10_000;

const rateLimits = new Map<string, { count: number; resetAt: number }>();
const recentSubscriptions = new Map<string, number>();
const pendingSubscriptions = new Map<string, Promise<number>>();

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function getBody(req: SubscribeRequest): SubscribeBody | null {
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined) {
    if (typeof contentLength !== 'string' || !/^\d+$/.test(contentLength)) return null;
    if (Number(contentLength) > MAX_BODY_BYTES) return null;
  }

  let body = req.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return null;
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  } else if (Buffer.isBuffer(body)) {
    if (body.byteLength > MAX_BODY_BYTES) return null;
    try {
      body = JSON.parse(body.toString('utf8'));
    } catch {
      return null;
    }
  } else {
    try {
      if (Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8') > MAX_BODY_BYTES) return null;
    } catch {
      return null;
    }
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return body as SubscribeBody;
}

function isSameOrigin(req: SubscribeRequest): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;

  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function getClientKey(req: SubscribeRequest): string {
  const realIp = req.headers['x-real-ip'];
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip =
    (typeof realIp === 'string' && realIp) ||
    (typeof forwardedFor === 'string' && forwardedFor.split(',')[0].trim()) ||
    'unknown';
  return createHash('sha256').update(ip).digest('hex');
}

function pruneExpired(now: number) {
  for (const [key, expiresAt] of recentSubscriptions) {
    if (expiresAt <= now) recentSubscriptions.delete(key);
  }
  for (const [key, entry] of rateLimits) {
    if (entry.resetAt <= now) rateLimits.delete(key);
  }
}

function allowRequest(clientKey: string, now: number): { allowed: boolean; resetAt: number } {
  const current = rateLimits.get(clientKey);
  if (!current || current.resetAt <= now) {
    if (rateLimits.size >= MAX_TRACKED_KEYS) {
      const oldestKey = rateLimits.keys().next().value;
      if (oldestKey) rateLimits.delete(oldestKey);
    }
    const resetAt = now + RATE_LIMIT_WINDOW_MS;
    rateLimits.set(clientKey, { count: 1, resetAt });
    return { allowed: true, resetAt };
  }
  if (current.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, resetAt: current.resetAt };
  }
  current.count += 1;
  return { allowed: true, resetAt: current.resetAt };
}

function rememberSubscription(key: string, now: number) {
  if (recentSubscriptions.size >= MAX_TRACKED_KEYS) {
    const oldestKey = recentSubscriptions.keys().next().value;
    if (oldestKey) recentSubscriptions.delete(oldestKey);
  }
  recentSubscriptions.set(key, now + DEDUPE_WINDOW_MS);
}

async function subscribeWithButtondown(
  email: string,
  tag: string,
  apiKey: string,
): Promise<number> {
  const bdRes = await fetch(BUTTONDOWN_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': 'application/json',
    },
    // Ask Buttondown to send the double opt-in confirmation email.
    body: JSON.stringify({ email, tags: [tag], type: 'unconfirmed' }),
  });

  if (bdRes.status === 201 || bdRes.status === 409) return 201;

  if (bdRes.status === 400 || bdRes.status === 422) {
    const body = (await bdRes.json()) as Record<string, unknown>;
    const code = typeof body?.code === 'string' ? body.code : 'unknown';
    if (code === 'email_already_exists' || code === 'subscriber_already_exists') return 201;
    return 422;
  }

  console.error('Buttondown unexpected status', bdRes.status);
  return 502;
}

export default async function handler(req: SubscribeRequest, res: ServerResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (!isSameOrigin(req)) {
    sendJson(res, 403, { error: 'origin_not_allowed' });
    return;
  }

  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    sendJson(res, 415, { error: 'unsupported_media_type' });
    return;
  }

  const body = getBody(req);
  if (!body) {
    sendJson(res, 400, { error: 'invalid_request' });
    return;
  }

  const apiKey = process.env.BUTTONDOWN_API_KEY;
  if (!apiKey) {
    console.error('BUTTONDOWN_API_KEY env var is not set');
    sendJson(res, 500, { error: 'Subscription service is not configured.' });
    return;
  }

  const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const tag = typeof body.tag === 'string' ? body.tag.trim() : 'newsletter';

  if (!rawEmail || rawEmail.length > 254 || !EMAIL_RE.test(rawEmail) || tag.length > 64) {
    sendJson(res, 422, { error: 'invalid_email' });
    return;
  }

  const now = Date.now();
  pruneExpired(now);
  const dedupeKey = createHash('sha256').update(rawEmail).digest('hex');
  if (recentSubscriptions.has(dedupeKey)) {
    sendJson(res, 201, { ok: true });
    return;
  }

  const pending = pendingSubscriptions.get(dedupeKey);
  if (pending) {
    const status = await pending;
    sendJson(
      res,
      status,
      status === 201 ? { ok: true } : { error: 'Subscription service is unavailable.' },
    );
    return;
  }

  const limit = allowRequest(getClientKey(req), now);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(Math.ceil((limit.resetAt - now) / 1000)));
    sendJson(res, 429, { error: 'rate_limited' });
    return;
  }

  try {
    const subscription = subscribeWithButtondown(rawEmail, tag, apiKey).catch((err) => {
      console.error('Buttondown fetch failed', err);
      return 502;
    });
    pendingSubscriptions.set(dedupeKey, subscription);
    const status = await subscription;
    if (status === 201) rememberSubscription(dedupeKey, now);
    if (status === 201) {
      sendJson(res, 201, { ok: true });
      return;
    }
    if (status === 422) {
      sendJson(res, 422, { error: 'invalid_email' });
      return;
    }
    sendJson(res, 502, { error: 'Subscription service is unavailable.' });
  } catch (err) {
    console.error('Buttondown fetch failed', err);
    sendJson(res, 502, { error: 'Subscription service is unavailable.' });
  } finally {
    pendingSubscriptions.delete(dedupeKey);
  }
}
