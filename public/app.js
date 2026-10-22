const COLORS = { open: '#1a7f43', closed: '#c0392b', unknown: '#7a8594', planned: '#b07d00' };
const $ = (id) => document.getElementById(id);
const pct = (r) => (r == null ? '–' : `${(r * 100).toFixed(1)}%`);
const fmt = (n) => n.toLocaleString();
const stateOf = (s) => (s.planned ? 'planned' : s.status);

// Behind Cloudflare Access, an expired sign-in makes the server answer with a redirect to the sign-in page. A
// redirect: 'manual' request reports that as an "opaqueredirect" instead of failing with a confusing network error.
class SessionExpired extends Error {}

async function getJson(url) {
  const res = await fetch(url, { redirect: 'manual' });
  if (res.type === 'opaqueredirect') throw new SessionExpired();
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

function showNotice(error) {
  const expired = error instanceof SessionExpired;
  $('notice-text').textContent = expired ? 'Your sign-in has expired.' : "Can't reach the server. Showing the last data.";
  $('notice-action').textContent = expired ? 'Sign in again' : 'Retry';
  $('notice-action').onclick = () => (expired ? location.reload() : load());
  $('notice').hidden = false;
}

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
    card.dataset.station = s.id;
    card.append(
      el('h3', {}, s.name, el('span', { className: `badge ${st}`, textContent: st })),
      el('div', { className: 'meta', textContent: `${s.highway} · MP ${[...new Set(s.locations.map((l) => l.milepost))].join(' / ')} · ${s.locations.map((l) => l.direction).join(', ')}` }),
    );
    if (s.phone) card.append(el('div', { className: 'meta' }, el('a', { href: `tel:${s.phone}`, textContent: s.phone })));
    if (s.note) card.append(el('p', { className: 'note', textContent: s.note }));
    const i = s.inspections;
    if (i?.total) card.append(el('div', { className: 'meta', textContent: `${fmt(i.total)} inspections (12 mo) · vehicle OOS ${pct(i.vehicleOosRate)} · driver OOS ${pct(i.driverOosRate)}` }));
    card.append(el('div', { className: 'when', textContent: s.planned ? 'Planned — not open yet' : ago(s.updatedAt) + (s.source && s.source !== 'manual' ? ` · via ${s.source}` : '') }));
    const actions = el('div', { className: 'actions' });
    if (!s.planned) {
      const btn = el('button', { className: 'update-btn', textContent: 'Update status' });
      btn.addEventListener('click', (e) => { e.stopPropagation(); openEditor(s); });
      actions.append(btn);
    }
    if (i?.total) {
      const btn = el('button', { textContent: 'Inspections' });
      btn.addEventListener('click', (e) => { e.stopPropagation(); openInspections(s); });
      actions.append(btn);
    }
    if (actions.children.length) card.append(actions);
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

// A notification opens the app at /?station=<id>: bring that station's card into view once, then drop the parameter.
function openStationFromLink() {
  const id = new URLSearchParams(location.search).get('station');
  if (!id) return;
  const card = [...document.querySelectorAll('.card[data-station]')].find((c) => c.dataset.station === id);
  if (!card) return;
  history.replaceState(null, '', location.pathname);
  card.scrollIntoView({ block: 'center' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 2500);
  const station = stations.find((s) => s.id === id);
  if (station) map.flyTo([station.locations[0].lat, station.locations[0].lng], 11);
}

async function load() {
  try {
    stations = (await getJson('/api/stations')).stations;
    render();
    window.followUi?.decorate();
    openStationFromLink();
    $('notice').hidden = true;
  } catch (error) {
    showNotice(error);
  }
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
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ status: $('f-status').value, note: $('f-note').value }),
  });
  if (res.type === 'opaqueredirect') { $('f-error').textContent = 'Your sign-in has expired. Reload the page to sign in again.'; return; }
  if (res.status === 401) {
    localStorage.setItem('needsToken', '1');
    $('token-row').hidden = false;
    $('f-error').textContent = 'Write token required.';
    return;
  }
  if (!res.ok) { $('f-error').textContent = (await res.json()).error; return; }
  if (token) localStorage.setItem('statusToken', token);
  $('editor').close();
  await load();
});

// --- inspection locations layer ---
const LOC_COLORS = { port: '#8e44ad', place: '#2b6cb0' };
const locLayer = L.layerGroup();
let locRequest = 0; // only the newest request may draw, so rapid filter changes can't stack circles
const prefs = { show: false, levels: [1, 2, 3, 4, 5], period: '12m' };
try { Object.assign(prefs, JSON.parse(localStorage.getItem('locPrefs') ?? '{}')); } catch { /* storage unavailable: defaults */ }
prefs.levels = [...new Set((Array.isArray(prefs.levels) ? prefs.levels : []).map(Number).filter((l) => [1, 2, 3, 4, 5].includes(l)))];
if (!['12m', 'all'].includes(prefs.period)) prefs.period = '12m';
prefs.show = prefs.show === true;
const savePrefs = () => { try { localStorage.setItem('locPrefs', JSON.stringify(prefs)); } catch { /* ignore */ } };

function locPopup(l) {
  const rows = l.byLevel.map((b) => el('li', { textContent: `Level ${b.level} · ${b.name}: ${fmt(b.count)}` }));
  return el('div', {},
    el('strong', { textContent: l.name }), ` · ${l.kind === 'port' ? 'port of entry' : 'town'}`,
    el('div', { textContent: `${fmt(l.total)} inspections` }),
    el('ul', { className: 'popup-rows' }, ...rows),
    el('div', { className: 'meta', textContent: `Vehicle OOS ${pct(l.vehicleOosRate)} · driver OOS ${pct(l.driverOosRate)}` }),
  );
}

async function loadLocations() {
  const mine = ++locRequest;
  $('loc-show').checked = prefs.show;
  $('loc-options').hidden = !prefs.show;
  locLayer.clearLayers();
  if (!prefs.show) { locLayer.remove(); $('loc-summary').textContent = ''; return; }
  if (!prefs.levels.length) { $('loc-summary').textContent = 'Pick at least one inspection level.'; return; }
  locLayer.addTo(map);
  let d;
  try {
    d = await getJson(`/api/inspection-locations?levels=${prefs.levels.join(',')}&period=${prefs.period}`);
  } catch (error) {
    if (mine !== locRequest) return;
    $('loc-summary').textContent = 'Could not load inspection locations.';
    if (error instanceof SessionExpired) showNotice(error);
    return;
  }
  if (mine !== locRequest) return;
  locLayer.clearLayers();
  for (const l of d.locations) { // largest first, so small locations draw on top of big ones
    L.circleMarker([l.lat, l.lng], {
      radius: Math.min(26, 4 + Math.sqrt(l.total) * 0.55),
      color: LOC_COLORS[l.kind], weight: 1, fillColor: LOC_COLORS[l.kind], fillOpacity: 0.4,
    }).bindPopup(locPopup(l)).bindTooltip(el('span', { textContent: `${l.name}: ${fmt(l.total)}` })).addTo(locLayer);
  }
  const total = d.locations.reduce((n, l) => n + l.total, 0);
  $('loc-summary').textContent = d.locations.length
    ? `${d.locations.length} locations · ${fmt(total)} inspections. Locations could be placed for ${pct(d.coverage.mappedShare)} of Colorado's inspections; the rest have no usable place name. Purple: ports of entry, blue: towns.`
    : 'No inspections for that selection.';
}

$('loc-show').addEventListener('change', (e) => { prefs.show = e.target.checked; savePrefs(); loadLocations(); });
$('loc-period').addEventListener('change', (e) => { prefs.period = e.target.value; savePrefs(); loadLocations(); });
for (const box of document.querySelectorAll('.loc-level')) {
  box.checked = prefs.levels.includes(Number(box.value));
  box.addEventListener('change', () => {
    prefs.levels = [...document.querySelectorAll('.loc-level')].filter((b) => b.checked).map((b) => Number(b.value));
    savePrefs();
    loadLocations();
  });
}
$('loc-period').value = prefs.period;
loadLocations();

let inspecting = null;

async function showInspections() {
  let d;
  try {
    d = await getJson(`/api/stations/${inspecting.id}/inspections?months=${$('insp-months').value}`);
  } catch (error) {
    $('insp-body').replaceChildren(el('p', { className: 'error', textContent: error instanceof SessionExpired ? 'Your sign-in has expired. Reload the page to sign in again.' : 'Could not load inspections.' }));
    return;
  }
  const max = Math.max(1, ...d.months.map((m) => m.count));
  const body = $('insp-body');
  body.replaceChildren(
    el('p', {}, el('strong', { textContent: fmt(d.total) }), ` inspections · vehicle OOS ${pct(d.vehicleOosRate)} · driver OOS ${pct(d.driverOosRate)}`),
    el('h3', { textContent: 'By inspection level' }),
    el('table', {}, ...d.byLevel.map((l) => el('tr', {}, el('td', { textContent: `Level ${l.level}` }), el('td', { textContent: l.name }), el('td', { className: 'num', textContent: fmt(l.count) })))),
    el('h3', { textContent: 'By month' }),
    el('div', { className: 'bars', role: 'img', ariaLabel: 'Inspections per month' },
      ...d.months.map((m) => el('div', { className: 'bar', title: `${m.month.slice(0, 4)}-${m.month.slice(4)}: ${m.count}`, style: `height:${(m.count / max) * 100}%` }))),
    el('div', { className: 'meta', textContent: `${d.months[0].month.slice(0, 4)}-${d.months[0].month.slice(4)} to ${d.through.slice(0, 4)}-${d.through.slice(4)} (latest month may be partial)` }),
  );
}

function openInspections(s) {
  inspecting = s;
  $('insp-title').textContent = `${s.name} inspections`;
  $('insp-months').value = '12';
  showInspections();
  $('insp').showModal();
}
$('insp-months').addEventListener('change', showInspections);
$('insp-close').addEventListener('click', () => $('insp').close());

load();
setInterval(load, 60_000);
