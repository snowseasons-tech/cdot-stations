const $ = (id) => document.getElementById(id);
const unlock = $('unlock');
const editor = $('editor');
const fields = editor.elements;
const day = 24 * 60 * 60 * 1000;
let key, map, markers, ports, pin, draft, originalTime, busy;
let reports = [];

async function api(path = '', method = 'GET', body) {
  const response = await fetch('/api/observations' + path, {
    method,
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

function button(label, click) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.addEventListener('click', click);
  return element;
}

function icon(draftPin = false) {
  return L.divIcon({ className: draftPin ? 'observation-pin draft-pin' : 'observation-pin',
    iconSize: draftPin ? [26, 26] : [18, 18] });
}

function setPoint({ lat, lng }, fromFields = false) {
  if (!fromFields) {
    fields.lat.value = lat.toFixed(5);
    fields.lng.value = lng.toFixed(5);
  }
  $('details').hidden = false;
  $('placement-tip').textContent = 'Drag the pin to adjust its location.';
  if (pin) {
    pin.setLatLng([lat, lng]);
    return;
  }
  pin = L.marker([lat, lng], { icon: icon(true), draggable: true, title: 'Drag to move observation' }).addTo(map);
  pin.on('dragend', () => setPoint(pin.getLatLng()));
}

function closeEditor() {
  draft = null;
  if (pin) pin.remove();
  pin = null;
  $('placement').hidden = true;
  editor.hidden = true;
  $('archive').hidden = false;
  $('add').disabled = false;
}

function openEditor(report = {}) {
  if (busy) return;
  closeEditor();
  draft = report;
  editor.reset();
  $('editor-title').textContent = report.id ? 'Edit observation' : 'New observation';
  $('edit-message').textContent = '';
  $('message').textContent = '';
  $('placement').hidden = false;
  $('placement-tip').textContent = 'Tap the map to place a pin.';
  $('details').hidden = true;
  const date = new Date(report.observedAt ?? Date.now());
  fields.observedAt.value = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  originalTime = fields.observedAt.value;
  for (const name of ['roadway', 'status', 'direction', 'notes']) {
    if (report[name] !== undefined) fields[name].value = report[name];
  }
  $('archive').hidden = true;
  editor.hidden = false;
  $('add').disabled = true;
  if (report.id) {
    setPoint(report);
    map.setView([report.lat, report.lng], Math.max(9, map.getZoom()));
    $('editor-title').scrollIntoView({ block: 'nearest' });
  } else {
    $('map').scrollIntoView({ block: 'nearest' });
  }
}

function render() {
  if (!markers || !key) return;
  markers.clearLayers();
  const list = $('reports');
  list.replaceChildren();
  const road = $('road-filter').value.toLowerCase().trim();
  const status = $('status-filter').value;
  const matching = reports.filter((report) => {
    const stale = report.stale || Date.now() - Date.parse(report.observedAt) >= day;
    return ($('old').checked || !stale) && (!status || status === report.status)
      && report.roadway.toLowerCase().includes(road);
  });
  for (const report of matching) {
    const stale = report.stale || Date.now() - Date.parse(report.observedAt) >= day;
    const entry = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = report.roadway + ' · ' + report.direction;
    const detail = document.createElement('p');
    detail.textContent = (stale ? 'Stale · ' : '') + report.status + ' when observed · ' + new Date(report.observedAt).toLocaleString();
    const notes = document.createElement('p');
    notes.textContent = report.notes;
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(button('Show on map', () => {
      map.setView([report.lat, report.lng], Math.max(9, map.getZoom()));
      $('map').scrollIntoView({ block: 'nearest' });
    }), button('Edit', () => openEditor(report)), button('Delete', () => remove(report)));
    entry.append(title, detail, notes, actions);
    list.append(entry);
    const marker = L.marker([report.lat, report.lng], { icon: icon(), opacity: stale ? 0.55 : 1,
      title: 'User-reported observation on ' + report.roadway }).addTo(markers);
    marker.on('click', () => {
      if (!draft) {
        entry.scrollIntoView({ block: 'nearest' });
        actions.firstElementChild.focus({ preventScroll: true });
      }
    });
  }
  if (!matching.length) {
    const empty = document.createElement('li');
    empty.textContent = reports.length ? 'No observations match these filters.' : 'No saved observations yet.';
    list.append(empty);
  }
}

async function work(action, target = $('message')) {
  if (busy) return;
  busy = true;
  target.textContent = '';
  try { await action(); }
  catch (error) { target.textContent = error.message; }
  finally { busy = false; }
}

function remove(report) {
  if (busy || !window.confirm('Delete this observation on ' + report.roadway + '?')) return;
  work(async () => {
    await api('/' + report.id, 'DELETE', { revision: report.revision });
    reports = reports.filter((item) => item.id !== report.id);
    render();
    $('message').textContent = 'Observation deleted.';
  });
}

unlock.addEventListener('submit', (event) => {
  event.preventDefault();
  work(async () => {
    if (!window.L) throw new Error('The map could not load. Check your connection and reload.');
    key = unlock.elements.key.value;
    unlock.reset();
    try { ({ reports } = await api()); }
    catch (error) { key = null; throw error; }
    $('workspace').hidden = $('add').hidden = $('lock').hidden = false;
    unlock.hidden = true;
    if (!map) {
      map = L.map('map', { scrollWheelZoom: false }).setView([39, -105.55], 7);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18, attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map);
      markers = L.layerGroup().addTo(map);
      ports = L.layerGroup().addTo(map);
      map.on('click', ({ latlng }) => { if (draft && !busy) setPoint(latlng); });
    }
    map.invalidateSize();
    render();
  });
});

$('lock').onclick = () => {
  if (busy) return;
  key = null;
  reports = [];
  markers.clearLayers();
  map.setView([39, -105.55], 7);
  $('road-filter').value = $('status-filter').value = '';
  $('old').checked = false;
  $('reports').replaceChildren();
  closeEditor();
  $('message').textContent = '';
  $('edit-message').textContent = '';
  editor.reset();
  $('workspace').hidden = $('add').hidden = $('lock').hidden = true;
  unlock.hidden = false;
  unlock.elements.key.focus();
};
$('add').onclick = () => openEditor();
$('cancel').onclick = () => {
  if (busy) return;
  closeEditor();
  $('message').textContent = '';
};
$('details').onclick = () => {
  $('editor-title').scrollIntoView({ block: 'start' });
  fields.roadway.focus({ preventScroll: true });
};
$('center').onclick = () => setPoint(map.getCenter());
for (const name of ['lat', 'lng']) fields[name].addEventListener('change', () => {
  if (Number.isFinite(fields.lat.valueAsNumber) && Number.isFinite(fields.lng.valueAsNumber)) {
    setPoint({ lat: fields.lat.valueAsNumber, lng: fields.lng.valueAsNumber }, true);
  }
});

editor.addEventListener('submit', (event) => {
  event.preventDefault();
  work(async () => {
    const body = Object.fromEntries(new FormData(editor));
    body.lat = Number(body.lat);
    body.lng = Number(body.lng);
    const local = new Date(body.observedAt);
    body.observedAt = draft.id && body.observedAt === originalTime ? draft.observedAt : local.toISOString();
    if (draft.id) body.revision = draft.revision;
    const saved = await api(draft.id ? '/' + draft.id : '', draft.id ? 'PUT' : 'POST', body);
    reports = [saved, ...reports.filter((item) => item.id !== saved.id)]
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt));
    if (saved.stale) $('old').checked = true;
    $('road-filter').value = $('status-filter').value = '';
    closeEditor();
    render();
    $('message').textContent = 'Observation saved.';
  }, $('edit-message'));
});

$('refresh').onclick = () => work(async () => { ({ reports } = await api()); render(); });
for (const id of ['road-filter', 'status-filter', 'old']) $(id).addEventListener('input', render);
setInterval(() => { if (!document.hidden) render(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

const officialNote = $('official-note').textContent;
let officialRequest = 0;
$('official').onchange = async (event) => {
  const request = ++officialRequest;
  ports.clearLayers();
  $('official-note').textContent = officialNote;
  if (!event.target.checked) return;
  try {
    const response = await fetch('/api/stations');
    if (!response.ok) throw new Error();
    const { stations, fetchedAt } = await response.json();
    if (request !== officialRequest) return;
    for (const station of stations.filter((item) => !item.planned)) {
      for (const point of station.locations) {
        const label = document.createElement('span');
        label.textContent = 'Official port location · ' + station.name + ' · ' + station.highway;
        L.circleMarker([point.lat, point.lng], { color: '#2649a0', radius: 7, fillOpacity: 0.8 })
          .bindTooltip(label).addTo(ports);
      }
    }
    $('official-note').textContent = officialNote + ' Port data fetched ' + new Date(fetchedAt).toLocaleDateString() + '.';
  } catch {
    if (request === officialRequest) $('official-note').textContent = 'Official port locations could not load. Toggle the layer to retry.';
  }
};
