// "Search inspections": asks the server for individual fixed-port inspections matching a place or carrier and a date
// range. Everything from the server is placed into the page as text, never as HTML.
(() => {
  const $ = (id) => document.getElementById(id);
  const dialog = $('search');
  if (!dialog) return;

  const loaded = []; // every result shown so far, kept so it can be exported

  const COLUMNS = [
    ['Date', (r) => r.date], ['Time', (r) => r.time], ['Place', (r) => r.place], ['Level', (r) => r.level],
    ['Level name', (r) => r.levelName], ['Violations', (r) => r.violations], ['Out of service', (r) => r.oos.total],
    ['Vehicle OOS', (r) => r.oos.vehicle], ['Driver OOS', (r) => r.oos.driver], ['Hazmat OOS', (r) => r.oos.hazmat],
    ['Carrier', (r) => r.carrier], ['City', (r) => r.city], ['State', (r) => r.state], ['DOT number', (r) => r.dot],
    ['Inspection ID', (r) => r.id],
  ];

  // One CSV cell. Text starting with = + - @ (or a tab/CR) would be run as a formula by Excel and Sheets, and carrier
  // names are other people's text, so those get a leading apostrophe. Quotes are doubled and the cell is quoted.
  const cell = (v) => {
    let t = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return `"${t.replaceAll('"', '""')}"`;
  };
  const toCsv = (rows) => [COLUMNS.map(([name]) => cell(name)).join(','), ...rows.map((r) => COLUMNS.map(([, get]) => cell(get(r))).join(','))].join('\r\n') + '\r\n';
  if (typeof globalThis.__searchExports === 'object') globalThis.__searchExports.toCsv = toCsv; // lets the tests reach it

  let latest = 0; // a slower, older answer must not overwrite a newer one
  let query = null;
  let shown = 0;

  const el = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
    return node;
  };

  const oosText = (oos) => {
    if (!oos.total) return null;
    const parts = [];
    if (oos.vehicle) parts.push('vehicle');
    if (oos.driver) parts.push('driver');
    if (oos.hazmat) parts.push('hazmat');
    return `Out of service${parts.length ? `: ${parts.join(', ')}` : ''}`;
  };

  const row = (r) => {
    const oos = oosText(r.oos);
    const when = [r.date, r.time].filter(Boolean).join(' ');
    const who = [r.carrier || 'Carrier not listed', [r.city, r.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    return el('li', {},
      el('div', { className: 'top' }, el('span', { textContent: r.place || 'Unknown place' }), el('span', { textContent: when })),
      el('div', { className: 'meta', textContent: who + (r.dot ? ` · DOT ${r.dot}` : '') }),
      el('div', { className: 'meta' },
        el('span', { textContent: `Level ${r.level || '?'} · ${r.levelName}` }),
        ` · ${r.violations} violation${r.violations === 1 ? '' : 's'}`,
        ...(oos ? [' · ', el('span', { className: 'oos', textContent: oos })] : [])),
    );
  };

  const params = (offset) => {
    const p = new URLSearchParams();
    for (const [key, id] of [['q', 's-q'], ['from', 's-from'], ['to', 's-to']]) if ($(id).value.trim()) p.set(key, $(id).value.trim());
    p.set('offset', String(offset));
    return p;
  };

  async function run(offset) {
    const mine = ++latest;
    const p = offset === 0 ? params(0) : query;
    if (offset > 0) p.set('offset', String(offset));
    if (offset === 0) { query = p; shown = 0; loaded.length = 0; $('s-results').replaceChildren(); }
    $('s-more').hidden = true;
    $('s-csv').hidden = true;
    $('s-status').textContent = 'Searching...';
    $('s-go').disabled = true;
    try {
      const res = await fetch(`/api/inspection-search?${p}`, { redirect: 'manual' });
      if (mine !== latest) return;
      if (res.type === 'opaqueredirect') throw Object.assign(new Error('expired'), { expired: true });
      const body = await res.json().catch(() => ({}));
      if (mine !== latest) return;
      if (res.status === 400) { $('s-status').textContent = body.error ?? 'Check the search and try again.'; return; }
      if (res.status === 429) { $('s-status').textContent = 'Too many searches. Wait a moment and try again.'; return; }
      if (!res.ok) throw new Error(String(res.status));
      $('s-results').append(...body.results.map(row));
      shown += body.results.length;
      loaded.push(...body.results);
      $('s-csv').hidden = !loaded.length;
      $('s-status').textContent = shown ? `Showing ${shown} inspection${shown === 1 ? '' : 's'}, newest first.` : 'No inspections matched.';
      $('s-more').hidden = !body.hasMore || offset + body.pageSize > 1000;
      if (body.hasMore && offset + body.pageSize > 1000) $('s-status').textContent += ' Narrow the dates to see older ones.';
    } catch (e) {
      if (mine !== latest) return;
      $('s-status').textContent = e.expired ? 'Your sign-in has expired. Reload the page to sign in again.' : 'Search is unavailable right now.';
    } finally {
      if (mine === latest) $('s-go').disabled = false;
    }
  }

  $('search-open').addEventListener('click', () => dialog.showModal());
  $('s-close').addEventListener('click', () => dialog.close());
  $('search-form').addEventListener('submit', (event) => { event.preventDefault(); run(0); });
  $('s-more').addEventListener('click', () => run(shown));
  $('s-csv').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob(['\ufeff', toCsv(loaded)], { type: 'text/csv;charset=utf-8' })); // BOM so Excel reads UTF-8
    const a = el('a', { href: url, download: `inspections-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
