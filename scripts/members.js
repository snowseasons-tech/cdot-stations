// Lists the people who have bought a membership, and marks them once their email is on the sign-in list.
//   node scripts/members.js pending            who still needs adding to the sign-in list
//   node scripts/members.js expired            whose time is up but whose email is still on the list (take them off)
//   node scripts/members.js list               everyone
//   node scripts/members.js grant <session-id>   mark one as added to the sign-in list
//   node scripts/members.js removed <session-id> mark one as taken off the list (time up, or refunded)
// Talks to a running server. Env: BASE_URL (default http://127.0.0.1:3000), STATUS_TOKEN (required).
const [command, id] = process.argv.slice(2);
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const token = process.env.STATUS_TOKEN;
const needsId = ['grant', 'removed'].includes(command);
if (!['pending', 'expired', 'list', 'grant', 'removed'].includes(command) || (needsId && !/^cs_[A-Za-z0-9_]+$/.test(id ?? ''))) {
  console.error('usage: node scripts/members.js pending | expired | list | grant <session-id> | removed <session-id>');
  process.exit(2);
}
if (!token) { console.error('STATUS_TOKEN is required'); process.exit(2); }

const call = async (path, method = 'GET') => {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`${method} ${path} failed (${res.status}): ${data.error ?? ''}`); process.exit(1); }
  return data;
};

if (command === 'grant') {
  const m = await call(`/api/members/${id}/granted`, 'POST');
  console.log(`Marked ${m.email ?? m.sessionId} as added to the sign-in list.`);
} else if (command === 'removed') {
  const m = await call(`/api/members/${id}/removed`, 'POST');
  console.log(`Marked ${m.email ?? m.sessionId} as taken off the sign-in list.`);
} else {
  const query = { pending: '?pending=1', expired: '?expired=1', list: '' }[command];
  const { members } = await call(`/api/members${query}`);
  if (!members.length) console.log({ pending: 'Nobody is waiting.', expired: 'Nobody has expired.', list: 'No purchases yet.' }[command]);
  for (const m of members) {
    const price = `${(m.amount / 100).toFixed(2)} ${String(m.currency).toUpperCase()}`;
    const term = m.expiresAt ? `until ${m.expiresAt.slice(0, 10)}` : 'lifetime';
    const state = m.removedAt ? 'removed' : m.accessGranted ? (m.expiresAt && Date.parse(m.expiresAt) <= Date.now() ? 'EXPIRED: take off' : 'added') : 'WAITING';
    console.log(`${m.sessionId}  ${m.email ?? '(NO EMAIL: contact the buyer via Stripe)'}  ${price}  paid ${m.paidAt.slice(0, 10)}  ${term}  ${state}${m.needsReview ? '  NEEDS REVIEW' : ''}`);
  }
}
