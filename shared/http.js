// Minimal dependency-free HTTP framework: routing, JSON bodies, cookies,
// static files and security headers.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const MAX_BODY = 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function assert(cond, status, message) {
  if (!cond) throw new HttpError(status, message);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  res.setHeader('Cache-Control', 'no-store');
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

export function createApp({ name = 'app' } = {}) {
  const routes = [];
  const statics = [];

  function route(method, pattern, ...handlers) {
    const keys = [];
    const source = pattern.replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    });
    routes.push({ method, re: new RegExp(`^${source}/?$`), keys, handlers });
  }

  function serveStatic(pathname, res) {
    for (const { prefix, dir } of statics) {
      const base = prefix.endsWith('/') ? prefix : prefix + '/';
      if (pathname !== prefix && !pathname.startsWith(base)) continue;
      let rel = '/' + pathname.slice(base.length);
      if (rel.endsWith('/')) rel += 'index.html';
      const file = path.resolve(dir, '.' + rel);
      if (!file.startsWith(dir + path.sep)) continue;
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      res.statusCode = 200;
      res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
      fs.createReadStream(file).pipe(res);
      return true;
    }
    return false;
  }

  async function handle(req, res) {
    setSecurityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    try {
      const match = routes.find((r) => r.method === req.method && r.re.test(pathname));
      if (!match) {
        if (req.method === 'GET' && serveStatic(pathname, res)) return;
        throw new HttpError(404, 'Not found');
      }
      const m = match.re.exec(pathname);
      const params = Object.fromEntries(match.keys.map((k, i) => [k, m[i + 1]]));
      let rawBody = '';
      let body = {};
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        rawBody = await readBody(req);
        if (rawBody) {
          const ct = req.headers['content-type'] || '';
          if (!ct.startsWith('application/json')) throw new HttpError(415, 'Expected application/json');
          try {
            body = JSON.parse(rawBody);
          } catch {
            throw new HttpError(400, 'Invalid JSON');
          }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            throw new HttpError(400, 'JSON body must be an object');
          }
        }
      }
      const ctx = {
        req,
        res,
        method: req.method,
        path: pathname,
        params,
        query: Object.fromEntries(url.searchParams),
        rawBody,
        body,
        cookies: parseCookies(req.headers.cookie),
        state: {},
      };
      for (const h of match.handlers) {
        const result = await h(ctx);
        if (res.writableEnded || res.headersSent) return;
        if (result !== undefined) return sendJson(res, 200, result);
      }
      if (!res.writableEnded) sendJson(res, 204, {});
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(`[${name}]`, err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Internal server error' : err.message });
      else res.end();
    }
  }

  return {
    get: (p, ...h) => route('GET', p, ...h),
    post: (p, ...h) => route('POST', p, ...h),
    static: (prefix, dir) => statics.push({ prefix, dir: path.resolve(dir) }),
    listen(port, host = process.env.HOST) {
      const server = http.createServer(handle);
      return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
    },
  };
}
