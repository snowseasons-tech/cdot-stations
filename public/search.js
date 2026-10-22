// "Search inspections": asks the server for individual fixed-port inspections matching a place or carrier and a date
// range. Everything from the server is placed into the page as text, never as HTML.
(() => {
  const $ = (id) => document.getElementById(id);
  const dialog = $('search');
  if (!dialog) return;

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
    const picked = [...document.querySelectorAll('.s-level')].filter((b) => b.checked).map((b) => b.value);
    if (picked.length && picked.length < 5) p.set('levels', picked.join(',')); // all five is the same as no filter
    if ($('s-oos').value) p.set('oos', $('s-oos').value);
    if ($('s-state').value.trim()) p.set('state', $('s-state').value.trim());
    p.set('offset', String(offset));
    return p;
  };

  async function run(offset) {
    if (offset === 0 && !document.querySelector('.s-level:checked')) { $('s-status').textContent = 'Pick at least one inspection level.'; return; }
    const mine = ++latest;
    const p = offset === 0 ? params(0) : query;
    if (offset > 0) p.set('offset', String(offset));
    if (offset === 0) { query = p; shown = 0; $('s-results').replaceChildren(); }
    $('s-more').hidden = true;
    $('s-csv').hidden = true;
    $('s-sql').hidden = true;
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
      $('s-csv').hidden = !shown;
      $('s-sql').hidden = !shown;
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
  // Downloads every match (the server caps it), not just what is on screen. Fetched rather than linked so an expired
  // sign-in or an error shows a message instead of saving a web page as a .csv file.
  const download = async (button, ext, label) => {
    if (!query) return;
    const p = new URLSearchParams(query);
    p.delete('offset');
    button.disabled = true;
    const was = $('s-status').textContent;
    $('s-status').textContent = `Preparing the ${label}...`;
    try {
      const res = await fetch(`/api/inspection-search.${ext}?${p}`, { redirect: 'manual' });
      if (res.type === 'opaqueredirect') throw Object.assign(new Error('expired'), { expired: true });
      if (res.status === 429) { $('s-status').textContent = 'Too many exports. Wait a moment and try again.'; return; }
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `inspections-${new Date().toISOString().slice(0, 10)}.${ext}` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const rows = res.headers.get('x-export-rows');
      $('s-status').textContent = res.headers.get('x-export-truncated') === '1'
        ? `Saved the newest ${rows} matches. There are more: narrow the dates to get the rest.`
        : `Saved all ${rows} matching inspections.`;
    } catch (e) {
      $('s-status').textContent = e.expired ? 'Your sign-in has expired. Reload the page to sign in again.' : `Could not prepare the ${label}.`;
      if (!e.expired && was) setTimeout(() => { if ($('s-status').textContent === `Could not prepare the ${label}.`) $('s-status').textContent = was; }, 4000);
    } finally {
      button.disabled = false;
    }
  };
  $('s-csv').addEventListener('click', () => download($('s-csv'), 'csv', 'CSV'));
  $('s-sql').addEventListener('click', () => download($('s-sql'), 'sql', 'MySQL file'));
})();
