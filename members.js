// Who has bought a Founding Member membership. A purchase is recorded when Stripe's verified webhook says it was paid;
// recording is idempotent (Stripe may deliver the same event more than once). Access to the tracker is granted by
// adding the buyer's email to the sign-in list (Cloudflare Access); `accessGranted` records that this was done.
import { readFile } from 'node:fs/promises';
import { AtomicWriter } from './atomic-writer.js';
import { addMonths } from './stripe.js';

const MAX_EVENTS = 500;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export const normalizeEmail = (value) => (typeof value === 'string' && EMAIL.test(value.trim()) ? value.trim().toLowerCase() : null);

export class Members {
  constructor(file) {
    this.file = file;
    this.state = { members: {}, events: [] };
    this.writer = new AtomicWriter(file);
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  save() { return this.writer.save(() => this.state); }
  get(sessionId) { return this.state.members[sessionId] ?? null; }
  list() { return Object.values(this.state.members).sort((a, b) => b.paidAt.localeCompare(a.paidAt)); }
  pending() { return this.list().filter((m) => !m.accessGranted && !m.removedAt); }
  // Members whose time is up but whose email is still on the sign-in list: the ones to take off.
  expired(now = Date.now()) { return this.list().filter((m) => m.expiresAt && Date.parse(m.expiresAt) <= now && m.accessGranted && !m.removedAt); }

  // Returns { recorded: true } the first time a paid session is seen and { recorded: false } for a repeat.
  async recordPurchase({ sessionId, eventId, email, name, amount, currency, paidAt, months = null, termKnown = true }) {
    if (eventId && this.state.events.includes(eventId)) return { recorded: false };
    if (eventId) this.state.events = [...this.state.events, eventId].slice(-MAX_EVENTS);
    if (this.state.members[sessionId]) { await this.save(); return { recorded: false }; }
    const clean = normalizeEmail(email);
    this.state.members[sessionId] = {
      sessionId, email: clean, name: typeof name === 'string' ? name.slice(0, 120) : null,
      amount, currency, paidAt,
      months, expiresAt: months ? addMonths(paidAt, months) : null, // null = lifetime
      needsReview: clean === null || !termKnown, // no usable email, or the term on the payment wasn't recognised: someone must look
      accessGranted: false, grantedAt: null, removedAt: null,
    };
    await this.save();
    return { recorded: true };
  }

  // Records that the buyer's email has been taken off the sign-in list (their time was up, or they were refunded).
  async markRemoved(sessionId) {
    const member = this.state.members[sessionId];
    if (!member) return null;
    member.accessGranted = false;
    member.removedAt ??= new Date().toISOString();
    await this.save();
    return member;
  }

  async markGranted(sessionId) {
    const member = this.state.members[sessionId];
    if (!member) return null;
    member.accessGranted = true;
    member.grantedAt ??= new Date().toISOString();
    await this.save();
    return member;
  }
}
