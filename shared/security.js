// Password hashing, tokens, cookie sessions and signed server-to-server calls.
import crypto from 'node:crypto';
import { HttpError } from './http.js';

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !stored) return false;
  const [salt, hash] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 32);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function generateOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

// ---------------------------------------------------------------------------
// Cookie sessions (in-memory, sliding expiry)
// ---------------------------------------------------------------------------

export function createSessions(cookieName, { ttlMs = 30 * 60 * 1000, secure = false } = {}) {
  const sessions = new Map();

  function cookie(value, maxAge) {
    return [
      `${cookieName}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${maxAge}`,
      secure ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; ');
  }

  return {
    create(res, data) {
      const sid = randomToken();
      sessions.set(sid, { data, expiresAt: Date.now() + ttlMs });
      res.setHeader('Set-Cookie', cookie(sid, Math.floor(ttlMs / 1000)));
    },
    get(ctx) {
      const sid = ctx.cookies[cookieName];
      const s = sid && sessions.get(sid);
      if (!s) return null;
      if (s.expiresAt < Date.now()) {
        sessions.delete(sid);
        return null;
      }
      s.expiresAt = Date.now() + ttlMs;
      return s.data;
    },
    destroy(ctx) {
      sessions.delete(ctx.cookies[cookieName]);
      ctx.res.setHeader('Set-Cookie', cookie('', 0));
    },
  };
}

// ---------------------------------------------------------------------------
// Signed server-to-server (S2S) requests between the Neobank and the Bank.
// signature = HMAC-SHA256(secret, `${timestamp}.${nonce}.${method}.${path}.${body}`)
// ---------------------------------------------------------------------------

const MAX_SKEW_MS = 5 * 60 * 1000;

function signature(secret, ts, nonce, method, path, body) {
  return crypto.createHmac('sha256', secret).update(`${ts}.${nonce}.${method}.${path}.${body}`).digest('hex');
}

export async function s2sRequest(baseUrl, method, path, body, secret) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = String(Date.now());
  const nonce = randomToken(12);
  const headers = {
    'x-timestamp': ts,
    'x-nonce': nonce,
    'x-signature': signature(secret, ts, nonce, method, path, raw),
  };
  if (raw) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(baseUrl + path, { method, headers, body: raw || undefined });
  } catch {
    throw new HttpError(502, 'Partner service is unavailable. Please try again.');
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(502, 'Invalid response from partner service');
  }
  // A 401 from the partner is a server-to-server problem, not the browser user's session.
  if (!res.ok) throw new HttpError(res.status === 401 ? 502 : res.status, data.error || `Upstream error ${res.status}`);
  return data;
}

// Middleware verifying an S2S signature, with replay protection.
export function requireSignature(secret) {
  const seen = new Map();
  return (ctx) => {
    const ts = ctx.req.headers['x-timestamp'];
    const nonce = ctx.req.headers['x-nonce'];
    const sig = ctx.req.headers['x-signature'];
    if (!ts || !nonce || !sig) throw new HttpError(401, 'Missing signature');
    if (Math.abs(Date.now() - Number(ts)) > MAX_SKEW_MS) throw new HttpError(401, 'Stale request');
    const expected = signature(secret, ts, nonce, ctx.method, ctx.path, ctx.rawBody);
    if (!safeEqual(sig, expected)) throw new HttpError(401, 'Bad signature');
    const now = Date.now();
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
    if (seen.has(nonce)) throw new HttpError(401, 'Replayed request');
    seen.set(nonce, now + MAX_SKEW_MS * 2);
  };
}
