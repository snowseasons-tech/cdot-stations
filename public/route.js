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
  function distanceToSegmentMeters(point, start, end) {
    const radius = 6371000;
    const radians = Math.PI / 180;
    const cosLat = Math.cos(point[0] * radians);
    const x = (lng) => radius * radians * (lng - point[1]) * cosLat;
    const y = (lat) => radius * radians * (lat - point[0]);
    const sx = x(start[1]), sy = y(start[0]);
    const dx = x(end[1]) - sx, dy = y(end[0]) - sy;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, -(sx * dx + sy * dy) / lengthSquared)) : 0;
    return Math.hypot(sx + t * dx, sy + t * dy);
  }
  function distanceToRouteMeters(point, coordinates) {
    if (coordinates.length === 1) {
      const [lng, lat] = coordinates[0];
      return haversine(point, [lat, lng]);
    }
    let nearest = Infinity;
    for (let i = 0; i < coordinates.length - 1; i++) {
      const [lngA, latA] = coordinates[i];
      const [lngB, latB] = coordinates[i + 1];
      nearest = Math.min(nearest, distanceToSegmentMeters(point, [latA, lngA], [latB, lngB]));
    }
    return nearest;
  }
  function routeClosures(route, stations) {
    const coordinates = route.geometry.coordinates;
    return stations.flatMap((station) => {
      if (station.status !== 'closed' || station.planned) return [];
      let nearest = Infinity;
      let routeLocation = null;
      for (const location of station.locations ?? []) {
        const distance = distanceToRouteMeters([location.lat, location.lng], coordinates);
        if (distance < nearest) {
          nearest = distance;
          routeLocation = location;
        }
      }
      return nearest <= 2500 ? [{ ...station, routeDistanceMeters: nearest, routeLocation }] : [];
    });
  }
  const distanceLabel = (meters) => meters >= 1000 ? (meters / 1000).toFixed(1) + ' km' : Math.round(meters) + ' m';
  function googleDirectionsUrl(route) {
    const url = new URL('https://www.google.com/maps/dir/');
    url.searchParams.set('api', '1');
    url.searchParams.set('origin', $('trip-from').value.trim());
    url.searchParams.set('destination', $('trip-to').value.trim());
    url.searchParams.set('travelmode', 'driving');

    // Keep at most three interior points so the selected route can be handed off on mobile too.
    const interior = route.geometry.coordinates.slice(1, -1);
    const count = Math.min(3, interior.length);
    if (count) {
      const points = Array.from({ length: count }, (_, i) => {
        const index = count === 1 ? 0 : Math.round(i * (interior.length - 1) / (count - 1));
        const [lng, lat] = interior[index];
        return lat.toFixed(5) + ',' + lng.toFixed(5);
      });
      url.searchParams.set('waypoints', points.join('|'));
    }
    return url.toString();
  }

  function reportedAgo(iso) {
    const updatedAt = Date.parse(iso);
    if (!Number.isFinite(updatedAt)) return 'report time unknown';
    const minutes = Math.max(0, Math.floor((Date.now() - updatedAt) / 60_000));
    if (minutes < 1) return 'reported just now';
    if (minutes < 60) return 'reported ' + minutes + ' min ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return 'reported ' + hours + ' h ago';
    const days = Math.floor(hours / 24);
    return 'reported ' + days + ' day' + (days === 1 ? '' : 's') + ' ago';
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
      if (affected.length) {
        const prefix = document.createElement('span');
        prefix.textContent = 'Station' + (affected.length === 1 ? '' : 's') + ' marked closed within 2.5 km: ';
        note.append(prefix);
        affected.forEach((station, stationIndex) => {
          if (stationIndex) note.append(document.createTextNode('; '));
          const location = station.routeLocation;
          if (location && window.conditionsLinks?.cotripMapUrl) {
            const link = document.createElement('a');
            link.href = window.conditionsLinks.cotripMapUrl(location);
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = station.name;
            note.append(link);
          } else {
            note.append(document.createTextNode(station.name));
          }
          const details = document.createElement('span');
          details.textContent = ' (' + distanceLabel(station.routeDistanceMeters) + ' from route; ' + reportedAgo(station.updatedAt) + ')';
          note.append(details);
        });
      } else {
        note.textContent = 'No stations are marked closed near this route.';
      }
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
      nav.href = googleDirectionsUrl(routes[selected]);
      nav.target = '_blank'; nav.rel = 'noopener noreferrer'; nav.className = 'button-link'; nav.textContent = 'Open selected route in Google Maps ↗';
      const navNote = document.createElement('span');
      navNote.className = 'route-meta';
      navNote.textContent = 'Google Maps will recalculate through up to three points on this route; the exact roads may differ.';
      results.append(nav, navNote);
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
