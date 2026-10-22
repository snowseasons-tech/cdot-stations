// Bearer-token checking and failed-attempt throttling for the write endpoints.
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s) => createHash('sha256').update(s).digest();

// Compares digests so the comparison takes the same time whatever the input length or content.
export function tokenMatches(authorizationHeader, token) {
  return timingSafeEqual(digest(authorizationHeader ?? ''), digest(`Bearer ${token}`));
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
