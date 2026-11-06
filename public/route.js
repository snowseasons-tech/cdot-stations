(() => {
  const $ = (id) => document.getElementById(id);
  const form = $('trip-form');
  const results = $('trip-results');
  const status = $('trip-status');
  const refreshButton = $('trip-refresh');
  if (!form || !refreshButton || typeof map === 'undefined') return;
  const layer = L.layerGroup().addTo(map);
  let routes = [];
  let selected = 0;
  let tripLabels = '';
  let refreshing = false;
  const colors = ['#135caa', '#a14a19', '#6b3ca0'];
  const number = (n) => new Intl.NumberFormat().format(n);
  const km = (m) => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
  const mins = (s) => { const m = Math.round(s / 60); return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min'; };
  const haversine = (a, b) => {
    const rad = (n) => n * Math.PI / 180;
    const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  };
  async function geocode(query) {
    const url = new URL('https://photon.komoot.io/api/');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '1');
    url.searchParams.set('lat', '39.0');
    url.searchParams.set('lon', '-105.5');
    const response = await fetch(url);
    if (!response.ok) throw new Error('Place search is temporarily unavailable.');
    const data = await response.json();
    const feature = data.features?.[0];
    if (!feature) throw new Error('Could not find “' + query + '”. Try a city, address, or highway intersection.');
    return { point: feature.geometry.coordinates, label: [feature.properties.name, feature.properties.city, feature.properties.state].filter(Boolean).join(', ') };
  }
  async function loadStations() {
    const response = await fetch('/api/stations', { redirect: 'manual' });
    if (!response.ok || response.type === 'opaqueredirect') throw new Error('Could not load current station statuses. Sign in again and retry.');
    return (await response.json()).stations ?? [];
  }
  function routeClosures(route, stations) {
    const coords = route.geometry.coordinates;
    const stride = Math.max(1, Math.floor(coords.length / 700));
    const samples = coords.filter((_, i) => i % stride === 0).map(([lng, lat]) => [lat, lng]);
    return stations.filter((station) => station.status === 'closed' && !station.planned && (station.locations ?? []).some((loc) =>
      samples.some((point) => haversine(point, [loc.lat, loc.lng]) <= 2500)));
  }
  function draw() {
    layer.clearLayers();
    results.replaceChildren();
    routes.forEach((route, index) => {
      const affected = route.closedStations;
      const card = document.createElement('article');
      card.className = 'route-option' + (index === selected ? ' selected' : '');
      const heading = document.createElement('strong');
      heading.textContent = (affected.length === 0 ? 'Recommended · ' : '') + 'Route ' + (index + 1);
      const meta = document.createElement('div');
      meta.className = 'route-meta';
      meta.textContent = km(route.distance) + ' · about ' + mins(route.duration);
      const note = document.createElement('div');
      note.className = affected.length ? 'route-alert' : 'route-clear';
      note.textContent = affected.length ? 'Near closed station' + (affected.length === 1 ? ': ' : 's: ') + affected.map((s) => s.name).join(', ') : 'No currently closed inspection stations detected near this route.';
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.textContent = index === selected ? 'Selected route' : 'View this route';
      choose.disabled = index === selected;
      choose.addEventListener('click', () => { selected = index; draw(); });
      card.append(heading, meta, note, choose);
      results.append(card);
      const line = L.geoJSON(route.geometry, { style: { color: colors[index % colors.length], weight: index === selected ? 7 : 5, opacity: index === selected ? .95 : .55, dashArray: index === selected ? null : '8 7' } }).addTo(layer);
      line.on('click', () => { selected = index; draw(); });
      route.bounds = line.getBounds();
    });
    if (routes[selected]) map.fitBounds(routes[selected].bounds, { padding: [24, 24] });
    if (routes.length) {
      const nav = document.createElement('a');
      nav.href = 'https://www.google.com/maps/dir/?api=1&origin=' + encodeURIComponent($('trip-from').value.trim()) + '&destination=' + encodeURIComponent($('trip-to').value.trim()) + '&travelmode=driving';
      nav.target = '_blank'; nav.rel = 'noopener noreferrer'; nav.className = 'button-link'; nav.textContent = 'Open directions in Google Maps ↗';
      results.append(nav);
    }
  }
  async function refreshStationReports() {
    if (!routes.length || refreshing) return;
    refreshing = true;
    refreshButton.disabled = true;
    status.textContent = 'Refreshing station reports…';
    try {
      const stations = await loadStations();
      routes = routes.map((route) => ({ ...route, closedStations: routeClosures(route, stations) }));
      routes.sort((a, b) => a.closedStations.length - b.closedStations.length || a.duration - b.duration);
      selected = 0;
      status.textContent = tripLabels + ' · Station reports refreshed at ' + new Date().toLocaleTimeString() + '. Reports may be out of date.';
      draw();
    } catch (error) {
      status.textContent = error.message || 'Could not refresh station reports. The previous route results are still shown.';
    } finally {
      refreshing = false;
      refreshButton.disabled = false;
    }
  }
  refreshButton.addEventListener('click', refreshStationReports);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const from = $('trip-from').value.trim(), to = $('trip-to').value.trim();
    if (!from || !to) return;
    status.textContent = 'Finding places and comparing routes…';
    routes = []; layer.clearLayers(); results.replaceChildren();
    $('trip-submit').disabled = true;
    refreshButton.hidden = true;
    try {
      const start = await geocode(from), end = await geocode(to);
      const url = 'https://router.project-osrm.org/route/v1/driving/' + start.point.join(',') + ';' + end.point.join(',') + '?alternatives=3&overview=full&geometries=geojson&steps=false';
      const response = await fetch(url);
      if (!response.ok) throw new Error('Route service is temporarily unavailable.');
      const data = await response.json();
      if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No driving route found for those places.');
      const stations = await loadStations();
      routes = data.routes.map((route) => ({ ...route, closedStations: routeClosures(route, stations) }));
      routes.sort((a, b) => a.closedStations.length - b.closedStations.length || a.duration - b.duration);
      selected = 0;
      tripLabels = start.label + ' → ' + end.label;
      status.textContent = tripLabels + ' · ' + routes.length + ' route option' + (routes.length === 1 ? '' : 's');
      refreshButton.hidden = false;
      draw();
    } catch (error) {
      status.textContent = error.message || 'Could not calculate this trip. Please try again.';
    } finally { $('trip-submit').disabled = false; }
  });
})();
