// Bearer-token checking and failed-attempt throttling for the write endpoints.
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s) => createHash('sha256').update(s).digest();

// Compares digests so the comparison takes the same time whatever the input length or content.
export function tokenMatches(authorizationHeader, token) {
  return timingSafeEqual(digest(authorizationHeader ?? ''), digest(`Bearer ${token}`));
}

// WRITE_TOKENS is a JSON object mapping a person's name to their personal token, e.g.
// {"alice":"<token>","bob":"<token>"}. It is optional: STATUS_TOKEN alone keeps working (one shared
// token, no author recorded). A bad configuration throws, so the server fails closed at startup.
export function parseWriteTokens(raw) {
  if (!raw) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('WRITE_TOKENS must be a JSON object like {"alice":"<token>"}');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('WRITE_TOKENS must be a JSON object like {"alice":"<token>"}');
  }
  const tokens = new Map();
  for (const [name, token] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9 _-]{1,40}$/.test(name)) throw new Error(`WRITE_TOKENS: bad name "${name}" (1-40 letters, digits, spaces, - or _)`);
    if (typeof token !== 'string' || token.length < 8) throw new Error(`WRITE_TOKENS: token for "${name}" must be a string of at least 8 characters`);
    tokens.set(name, token);
  }
  return tokens;
}

// Finds which write token the Authorization header carries. Returns the user's name when a personal
// token matched, 'shared' when it matched the single STATUS_TOKEN, or null when nothing matched.
// Every candidate is compared (not just until the first hit), so the time taken doesn't reveal
// which token came close; personal tokens are checked first so a value used both ways audits the person.
export function identify(authorizationHeader, { token, tokens } = {}) {
  const headerDigest = digest(authorizationHeader ?? '');
  let match = null;
  const check = (name, value) => {
    if (timingSafeEqual(headerDigest, digest(`Bearer ${value}`))) match = name;
  };
  if (tokens) for (const [name, value] of tokens) check(name, value);
  if (token) check('shared', token);
  return match;
}

// Counts failed attempts per client; once a client has `max` failures inside `windowMs` it is
// locked out (without checking the token at all) until the window passes.
export class FailureLimiter {
  constructor({ max = 10, windowMs = 60_000, now = () => Date.now() } = {}) {
    Object.assign(this, { max, windowMs, now });
    this.clients = new Map();
  }

  // Seconds until the client may try again, or 0 if it isn't locked out.
  retryAfter(client) {
    const e = this.clients.get(client);
    if (!e) return 0;
    if (e.resetAt <= this.now()) { this.clients.delete(client); return 0; }
    return e.count >= this.max ? Math.ceil((e.resetAt - this.now()) / 1000) : 0;
  }

  fail(client) {
    const t = this.now();
    if (this.clients.size > 1000) for (const [k, e] of this.clients) if (e.resetAt <= t) this.clients.delete(k);
    const e = this.clients.get(client);
    if (!e || e.resetAt <= t) this.clients.set(client, { count: 1, resetAt: t + this.windowMs });
    else e.count++;
  }
}

// Counts every request from a client (not just failures); once it has made `max` in the window it must wait.
export class RateLimiter extends FailureLimiter {
  // Returns 0 if the request may go ahead (and counts it), or the seconds to wait.
  allow(client) {
    const wait = this.retryAfter(client);
    if (wait) return wait;
    this.fail(client);
    return 0;
  }
}
