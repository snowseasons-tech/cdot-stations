// Fetches a JSON array of records from a URL (e.g. a feed you or a partner publishes).
export async function fetchStatuses({ url, header }) {
  if (!url) throw new Error('url adapter needs --url');
  const headers = header ? Object.fromEntries([header.split(/:\s*(.*)/s).slice(0, 2)]) : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('feed must be a JSON array of { station, status, note?, updatedAt? }');
  return data;
}
