// Fetches statuses with an adapter and posts them to a running server's /api/import.
//   node scripts/import-status.js --adapter file --path statuses.csv
//   node scripts/import-status.js --adapter url --url https://example.com/feed.json [--header "X-Key: abc"]
// Env: BASE_URL (default http://127.0.0.1:3000), STATUS_TOKEN
import { parseArgs } from 'node:util';
import { adapters } from '../adapters/index.js';

const { values } = parseArgs({ options: { adapter: { type: 'string' }, path: { type: 'string' }, url: { type: 'string' }, header: { type: 'string' }, source: { type: 'string' } } });
const adapter = adapters[values.adapter];
if (!adapter) {
  console.error(`--adapter must be one of: ${Object.keys(adapters).join(', ')}`);
  process.exit(2);
}

const records = await adapter.fetchStatuses(values);
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const token = process.env.STATUS_TOKEN;
const res = await fetch(`${base}/api/import`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
  body: JSON.stringify({ source: values.source ?? values.adapter, records }),
});
const body = await res.json();
if (!res.ok) { console.error(`Import failed (${res.status}): ${body.error}`); process.exit(1); }
console.log(`updated ${body.updated.length}, unchanged ${body.unchanged.length}, skipped ${body.skipped.length}`);
for (const s of body.skipped) console.log(`  skipped ${JSON.stringify(s.record)}: ${s.reason}`);
