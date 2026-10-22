// Moving a station's pin. Ports do get relocated, and CDOT's layer can be years old: a team member who has seen the
// new location clicks the map (or drags the orange pin), says why, and saves it with the write token. Runs after app.js
// and uses its helpers (map, stations, el, $, getJson, SessionExpired, showNotice, load). Web page only: in the
// installed app the Move pin buttons are hidden, like the other editing controls.
(function () {
  const EARTH_RADIUS_MILES = 3958.8;
  const rad = (d) => (d * Math.PI) / 180;
  function miles(a, b) { // same formula the server uses
    const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  const panel = $('mover');
  let activeId = null;
  let editMarker = null;
  let busy = false;

  const station = () => stations.find((s) => s.id === activeId);
  const location = () => station()?.locations.find((l) => l.direction === $('mv-direction').value);
  const original = (l) => l.original ?? { lat: l.lat, lng: l.lng }; // CDOT's position for this pin

  function refreshInfo() {
    const l = location();
    const point = { lat: Number($('mv-lat').value), lng: Number($('mv-lng').value) };
    if (!l || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) { $('mv-info').textContent = ''; return; }
    const away = miles(original(l), point);
    $('mv-info').textContent = `${away < 0.01 ? 'At' : `${away.toFixed(2)} miles from`} CDOT's listed position (${original(l).lat.toFixed(5)}, ${original(l).lng.toFixed(5)}).`;
  }

  function setPoint(lat, lng, { fly = false } = {}) {
    $('mv-lat').value = lat.toFixed(6);
    $('mv-lng').value = lng.toFixed(6);
    if (editMarker) editMarker.setLatLng([lat, lng]);
    else {
      editMarker = L.marker([lat, lng], { draggable: true, title: 'New position', icon: L.divIcon({ className: '', html: '<div class="pin move-pin"></div>', iconSize: [18, 18] }) }).addTo(map);
      editMarker.on('dragend', () => { const p = editMarker.getLatLng(); setPoint(p.lat, p.lng); });
    }
    if (fly) map.flyTo([lat, lng], Math.max(map.getZoom(), 13));
    refreshInfo();
  }

  function loadDirection() {
    const l = location();
    $('mv-revert').hidden = !l.correction;
    $('mv-note').value = l.correction?.note ?? '';
    $('mv-error').textContent = '';
    setPoint(l.lat, l.lng, { fly: true });
  }

  function start(id) {
    activeId = id;
    const s = station();
    $('mover-title').textContent = `Move ${s.name}`;
    $('mv-direction').replaceChildren(...s.locations.map((l) => el('option', { value: l.direction, textContent: `${l.direction}${l.correction ? ' (moved)' : ''}` })));
    $('mv-token-row').hidden = !localStorage.getItem('needsToken');
    $('mv-token').value = localStorage.getItem('statusToken') ?? '';
    panel.hidden = false;
    panel.scrollIntoView({ block: 'nearest' });
    loadDirection();
  }

  function stop() {
    activeId = null;
    panel.hidden = true;
    editMarker?.remove();
    editMarker = null;
  }

  async function send(method, body) {
    const token = $('mv-token').value;
    const res = await fetch(`/api/stations/${activeId}/locations/${encodeURIComponent($('mv-direction').value)}/position`, {
      method, redirect: 'manual',
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body && JSON.stringify(body),
    });
    if (res.type === 'opaqueredirect') throw new SessionExpired();
    if (res.status === 401) { localStorage.setItem('needsToken', '1'); $('mv-token-row').hidden = false; throw new Error('Write token required.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Something went wrong (${res.status}).`);
    if (token) localStorage.setItem('statusToken', token);
    return data;
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    $('mv-error').textContent = '';
    for (const b of panel.querySelectorAll('button')) b.disabled = true;
    try {
      await action();
      stop();
      await load(); // redraw every pin from the server
    } catch (error) {
      if (error instanceof SessionExpired) { showNotice(error); $('mv-error').textContent = 'Your sign-in has expired. Reload the page to sign in again.'; }
      else $('mv-error').textContent = error.message;
    } finally {
      busy = false;
      for (const b of panel.querySelectorAll('button')) b.disabled = false;
    }
  }

  async function showHistory() {
    const list = $('pos-history-list');
    try {
      const entries = await getJson(`/api/stations/${activeId}/positions`);
      list.replaceChildren(...(entries.length ? entries.map((e) => el('li', {
        textContent: `${new Date(e.savedAt).toLocaleString()}: ${e.action === 'revert' ? `${e.direction} put back to CDOT's position` : `${e.direction} moved to ${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}`}${e.note ? ` (${e.note})` : ''}`,
      })) : [el('li', { textContent: 'Nothing saved yet.' })]));
    } catch {
      list.replaceChildren(el('li', { textContent: 'Could not load the history.' }));
    }
    $('pos-history-title').textContent = `${station().name}: position history`;
    $('pos-history').showModal();
  }

  // ---- wiring ----
  $('mv-direction').addEventListener('change', loadDirection);
  for (const id of ['mv-lat', 'mv-lng']) {
    $(id).addEventListener('change', () => {
      const lat = Number($('mv-lat').value), lng = Number($('mv-lng').value);
      if (Number.isFinite(lat) && Number.isFinite(lng)) setPoint(lat, lng);
      else $('mv-error').textContent = 'Latitude and longitude must be numbers.';
    });
  }
  map.on('click', (e) => { if (activeId && !busy) setPoint(e.latlng.lat, e.latlng.lng); });
  $('mv-save').addEventListener('click', () => run(() => send('PUT', { lat: Number($('mv-lat').value), lng: Number($('mv-lng').value), note: $('mv-note').value })));
  $('mv-revert').addEventListener('click', () => run(() => send('DELETE')));
  $('mv-cancel').addEventListener('click', stop);
  $('mv-history').addEventListener('click', showHistory);
  $('pos-history-close').addEventListener('click', () => $('pos-history').close());

  // Adds a Move pin button to every station card. Called after each redraw of the list.
  function decorate() {
    for (const card of document.querySelectorAll('.card[data-station]')) {
      if (card.querySelector('.move-btn')) continue;
      let actions = card.querySelector('.actions');
      if (!actions) { actions = el('div', { className: 'actions' }); card.append(actions); }
      const button = el('button', { className: 'update-btn move-btn', type: 'button', textContent: 'Move pin' });
      button.addEventListener('click', (e) => { e.stopPropagation(); start(card.dataset.station); });
      actions.append(button);
    }
  }

  window.moveUi = { decorate };
})();
