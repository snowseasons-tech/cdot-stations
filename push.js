// Web push notifications: who follows which station, and sending a notification when a station changes.
// The browser/phone gives each installed app a "push subscription" (an address at Apple's, Google's or Mozilla's
// push service plus encryption keys); we keep it with the stations that person follows and, when a station's status
// or note changes, send each follower a message through that push service.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AtomicWriter } from './atomic-writer.js';

export const MAX_SUBSCRIPTIONS = 500;
export class LimitReached extends Error {}
const MAX_STATIONS_PER_SUBSCRIPTION = 50;
const SEND_CONCURRENCY = 20;
const TTL_SECONDS = 6 * 60 * 60; // a status notification is useless after a few hours

// The server POSTs to a subscription's endpoint, so an attacker-chosen address would turn it into a tool for
// making requests to anywhere (including the home network). Only the real push services are accepted.
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const PUSH_HOST_SUFFIXES = ['.notify.windows.com'];

export function isPushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 1000) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return PUSH_HOSTS.has(url.hostname) || PUSH_HOST_SUFFIXES.some((s) => url.hostname.endsWith(s));
}

const B64URL = /^[A-Za-z0-9_-]+$/;

// Returns { subscription: { endpoint, keys }, stations: ['all'] | [ids] } or throws RangeError with a message that
// is safe to show. An empty list of stations means "unfollow everything".
export function validateRequest(body, knownIds) {
  const sub = body?.subscription;
  if (!isPushEndpoint(sub?.endpoint)) throw new RangeError('subscription.endpoint must be a push service address');
  const { p256dh, auth } = sub.keys ?? {};
  if (typeof p256dh !== 'string' || !B64URL.test(p256dh) || p256dh.length < 80 || p256dh.length > 100) throw new RangeError('subscription.keys.p256dh is invalid');
  if (typeof auth !== 'string' || !B64URL.test(auth) || auth.length < 20 || auth.length > 30) throw new RangeError('subscription.keys.auth is invalid');
  const stations = body.stations;
  if (!Array.isArray(stations) || stations.length > MAX_STATIONS_PER_SUBSCRIPTION) throw new RangeError('stations must be an array');
  const unique = [...new Set(stations)];
  if (unique.includes('all')) {
    if (unique.length > 1) throw new RangeError('"all" cannot be combined with station ids');
    return { subscription: { endpoint: sub.endpoint, keys: { p256dh, auth } }, stations: ['all'] };
  }
  const unknown = unique.filter((id) => !knownIds.has(id));
  if (unknown.length) throw new RangeError(`unknown station: ${String(unknown[0]).slice(0, 40)}`);
  return { subscription: { endpoint: sub.endpoint, keys: { p256dh, auth } }, stations: unique };
}

export class Subscriptions {
  constructor(file) {
    this.state = { subscriptions: {} };
    this.writer = new AtomicWriter(file);
    this.file = file;
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  static key(endpoint) { return createHash('sha256').update(endpoint).digest('base64url'); }
  count() { return Object.keys(this.state.subscriptions).length; }
  following(endpoint) { return this.state.subscriptions[Subscriptions.key(endpoint)]?.stations ?? []; }

  // Followers of a station: everyone following it or following "all".
  forStation(id) {
    return Object.values(this.state.subscriptions).filter((s) => s.stations.includes('all') || s.stations.includes(id));
  }

  save() { return this.writer.save(() => this.state); }

  // Adds or updates one device's subscription. An empty list of stations removes it. Throws RangeError when full.
  async set({ endpoint, keys }, stations) {
    const key = Subscriptions.key(endpoint);
    if (!stations.length) return this.remove(endpoint);
    const existing = this.state.subscriptions[key];
    if (!existing && this.count() >= MAX_SUBSCRIPTIONS) throw new LimitReached('the subscription limit has been reached');
    const now = new Date().toISOString();
    this.state.subscriptions[key] = { endpoint, keys, stations, createdAt: existing?.createdAt ?? now, updatedAt: now };
    await this.save();
    return { stations };
  }

  async remove(endpoint) {
    const key = Subscriptions.key(endpoint);
    const had = key in this.state.subscriptions;
    delete this.state.subscriptions[key];
    if (had) await this.save();
    return { stations: [], removed: had };
  }
}

const LABELS = { open: 'Open', closed: 'Closed', unknown: 'Status unknown' };

// The notification a follower sees. The tag makes a newer notification about the same station replace the older one.
export function buildMessage(station, previous, current) {
  const statusChanged = previous.status !== current.status;
  const body = current.note || (statusChanged ? `Was ${previous.status}.` : 'Note cleared.');
  return {
    title: `${station.name}: ${statusChanged ? LABELS[current.status] : 'note updated'}`,
    body,
    tag: station.id,
    url: `/?station=${encodeURIComponent(station.id)}`,
  };
}

export function createNotifier({ subscriptions, stations, sender, log = console }) {
  const byId = new Map(stations.map((s) => [s.id, s]));
  const pending = new Set();

  async function notify({ id, previous, current }) {
    const station = byId.get(id);
    if (!station) return { sent: 0, removed: 0, failed: 0 };
    const payload = JSON.stringify(buildMessage(station, previous, current));
    const result = { sent: 0, removed: 0, failed: 0 };
    const targets = subscriptions.forStation(id);
    for (let i = 0; i < targets.length; i += SEND_CONCURRENCY) {
      await Promise.all(targets.slice(i, i + SEND_CONCURRENCY).map(async ({ endpoint, keys }) => {
        try {
          await sender({ endpoint, keys }, payload, { TTL: TTL_SECONDS, urgency: 'normal', topic: id.slice(0, 32) });
          result.sent++;
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) { // the push service says this device is gone
            await subscriptions.remove(endpoint);
            result.removed++;
          } else {
            result.failed++;
            log.error(`push to ${new URL(endpoint).hostname} failed: ${e.statusCode ?? ''} ${e.message}`);
          }
        }
      }));
    }
    return result;
  }

  return {
    // Fire and forget from the caller's point of view; `idle()` lets tests wait for in-flight sends.
    notify(event) {
      const p = notify(event).catch((e) => log.error(`notify failed: ${e.message}`)).finally(() => pending.delete(p));
      pending.add(p);
      return p;
    },
    idle: () => Promise.all([...pending]),
  };
}

// VAPID keys identify this server to the push services. All three must be set, or none (push is then off).
export function loadPushConfig(env = process.env) {
  const publicKey = env.VAPID_PUBLIC_KEY, privateKey = env.VAPID_PRIVATE_KEY, subject = env.VAPID_SUBJECT;
  if (!publicKey && !privateKey && !subject) return null;
  const missing = [['VAPID_PUBLIC_KEY', publicKey], ['VAPID_PRIVATE_KEY', privateKey], ['VAPID_SUBJECT', subject]].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Push notifications are partly configured; also set: ${missing.join(', ')}`);
  if (!/^(mailto:|https:)/.test(subject)) throw new Error('VAPID_SUBJECT must be a mailto: address or an https: URL');
  return { publicKey, privateKey, subject };
}

// The real sender, using the web-push package (loaded only when push is configured).
export async function createWebPushSender({ publicKey, privateKey, subject }) {
  const { default: webpush } = await import('web-push');
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return (subscription, payload, options) => webpush.sendNotification(subscription, payload, { timeout: 10_000, ...options });
}
