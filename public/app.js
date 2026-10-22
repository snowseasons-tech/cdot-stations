const COLORS = { open: '#1a7f43', closed: '#c0392b', unknown: '#7a8594', planned: '#b07d00' };
const $ = (id) => document.getElementById(id);
const stateOf = (s) => (s.planned ? 'planned' : s.status);

const map = L.map('map').setView([39.0, -105.55], 7);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
const markers = new Map();
let stations = [];
let editing = null;

function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
}

function ago(iso) {
  if (!iso) return 'No report yet';
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'Updated just now';
  if (mins < 60) return `Updated ${mins} min ago`;
  if (mins < 1440) return `Updated ${Math.round(mins / 60)} h ago`;
  return `Updated ${new Date(iso).toLocaleDateString()}`;
}

function render() {
  const list = $('list');
  list.replaceChildren();
  for (const s of stations) {
    const st = stateOf(s);
    const card = el('article', { className: 'card', tabIndex: 0 });
    card.append(
      el('h3', {}, s.name, el('span', { className: `badge ${st}`, textContent: st })),
      el('div', { className: 'meta', textContent: `${s.highway} · MP ${[...new Set(s.locations.map((l) => l.milepost))].join(' / ')} · ${s.locations.map((l) => l.direction).join(', ')}` }),
    );
    if (s.phone) card.append(el('div', { className: 'meta' }, el('a', { href: `tel:${s.phone}`, textContent: s.phone })));
    if (s.note) card.append(el('p', { className: 'note', textContent: s.note }));
    card.append(el('div', { className: 'when', textContent: s.planned ? 'Planned — not open yet' : ago(s.updatedAt) }));
    if (!s.planned) {
      const btn = el('button', { textContent: 'Update status' });
      btn.addEventListener('click', (e) => { e.stopPropagation(); openEditor(s); });
      card.append(el('div', { className: 'actions' }, btn));
    }
    const focus = () => map.flyTo([s.locations[0].lat, s.locations[0].lng], 11);
    card.addEventListener('click', focus);
    card.addEventListener('keydown', (e) => e.key === 'Enter' && e.target === card && focus());
    list.append(card);
  }
  for (const s of stations) {
    markers.get(s.id)?.forEach((m) => m.remove());
    const ms = s.locations.map((l) => {
      const popup = el('div', {}, el('strong', { textContent: s.name }), ` (${l.direction})`, el('br'), `${s.highway} MP ${l.milepost}`, el('br'), stateOf(s) + (s.note ? ` — ${s.note}` : ''));
      return L.marker([l.lat, l.lng], {
        title: `${s.name} ${l.direction}`,
        icon: L.divIcon({ className: '', html: `<div class="pin" style="background:${COLORS[stateOf(s)]}"></div>`, iconSize: [18, 18] }),
      }).addTo(map).bindPopup(popup);
    });
    markers.set(s.id, ms);
  }
}

async function load() {
  const res = await fetch('/api/stations');
  stations = (await res.json()).stations;
  render();
}

function openEditor(s) {
  editing = s;
  $('editor-title').textContent = s.name;
  $('f-status').value = s.status;
  $('f-note').value = s.note ?? '';
  $('f-error').textContent = '';
  $('token-row').hidden = !localStorage.getItem('needsToken');
  $('f-token').value = localStorage.getItem('statusToken') ?? '';
  $('editor').showModal();
}

$('f-save').addEventListener('click', async (e) => {
  e.preventDefault();
  const token = $('f-token').value;
  const res = await fetch(`/api/stations/${editing.id}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ status: $('f-status').value, note: $('f-note').value }),
  });
  if (res.status === 401) {
    localStorage.setItem('needsToken', '1');
    $('token-row').hidden = false;
    $('f-error').textContent = 'Access token required.';
    return;
  }
  if (!res.ok) { $('f-error').textContent = (await res.json()).error; return; }
  if (token) localStorage.setItem('statusToken', token);
  $('editor').close();
  await load();
});

load();
setInterval(load, 60_000);
