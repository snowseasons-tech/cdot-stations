// Lists the people who have bought a membership, and marks them once their email is on the sign-in list.
//   node scripts/members.js pending            who still needs adding to the sign-in list
//   node scripts/members.js list               everyone
//   node scripts/members.js grant <session-id> mark one as done
// Talks to a running server. Env: BASE_URL (default http://127.0.0.1:3000), STATUS_TOKEN (required).
const [command, id] = process.argv.slice(2);
const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const token = process.env.STATUS_TOKEN;
if (!['pending', 'list', 'grant'].includes(command) || (command === 'grant' && !/^cs_[A-Za-z0-9_]+$/.test(id ?? ''))) {
  console.error('usage: node scripts/members.js pending | list | grant <session-id>');
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
} else {
  const { members } = await call(`/api/members${command === 'pending' ? '?pending=1' : ''}`);
  if (!members.length) console.log(command === 'pending' ? 'Nobody is waiting.' : 'No purchases yet.');
  for (const m of members) {
    const price = `${(m.amount / 100).toFixed(2)} ${String(m.currency).toUpperCase()}`;
    console.log(`${m.sessionId}  ${m.email ?? '(NO EMAIL: contact the buyer via Stripe)'}  ${price}  ${m.paidAt.slice(0, 10)}  ${m.accessGranted ? 'added' : 'WAITING'}`);
  }
}
