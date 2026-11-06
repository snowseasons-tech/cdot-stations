(() => {
  const dialog = document.getElementById('history');
  const list = document.getElementById('history-list');
  const title = document.getElementById('history-title');
  if (!dialog || !list || !title) return;
  const node = (tag, props = {}, ...children) => {
    const element = Object.assign(document.createElement(tag), props);
    element.append(...children);
    return element;
  };
  const stateClass = (status) => ['open', 'closed', 'unknown'].includes(status) ? status : 'unknown';
  document.addEventListener('station-history-open', async (event) => {
    const { id, name } = event.detail ?? {};
    if (!id || !name) return;
    title.textContent = name + ' status history';
    list.replaceChildren(node('p', { className: 'sub', textContent: 'Loading history…' }));
    dialog.showModal();
    try {
      const response = await fetch('/api/stations/' + encodeURIComponent(id) + '/history', { redirect: 'manual' });
      if (response.type === 'opaqueredirect') throw new Error('Your sign-in has expired. Reload the page to sign in again.');
      if (!response.ok) throw new Error('Could not load status history (' + response.status + ').');
      const entries = await response.json();
      if (!Array.isArray(entries)) throw new Error('The server returned an unexpected history response.');
      if (!entries.length) {
        list.replaceChildren(node('p', { className: 'sub', textContent: 'No status changes have been recorded for this station.' }));
        return;
      }
      list.replaceChildren(...entries.map((entry) => {
        const badge = node('span', { className: 'badge ' + stateClass(entry.status), textContent: entry.status || 'unknown' });
        const timestamp = new Date(entry.updatedAt);
        const when = Number.isNaN(timestamp.valueOf()) ? 'Time unavailable' : timestamp.toLocaleString();
        const meta = [when, entry.source && 'via ' + entry.source].filter(Boolean).join(' · ');
        const item = node('li', { className: 'history-entry' },
          node('div', { className: 'history-heading' }, badge, node('time', { dateTime: entry.updatedAt || '', textContent: meta })),
        );
        if (entry.note) item.append(node('p', { className: 'history-note', textContent: entry.note }));
        return item;
      }));
    } catch (error) {
      list.replaceChildren(node('p', { className: 'error', role: 'alert', textContent: error.message || 'Could not load status history.' }));
    }
  });
  document.getElementById('history-close')?.addEventListener('click', () => dialog.close());
})();
