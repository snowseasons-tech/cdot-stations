// Links to CDOT's real-time traveler information (COtrip). This app doesn't show that data itself; it sends you to
// the source, opened on the right place with the useful layers already switched on.
(function () {
  // COtrip's own names for its map layers (lower-case, spaces as underscores), checked against the live site:
  // traffic incidents, road closures, construction, weather alerts and weather radar.
  const LAYERS = ['traffic_incidents', 'closures', 'construction', 'weather_alerts', 'weather_radar'];
  const COTRIP = 'https://www.cotrip.org/';

  // COtrip's map centred on a point, with the layers above on.
  function cotripMapUrl({ lat, lng }, zoom = 11) {
    const query = new URLSearchParams({ lat: lat.toFixed(4), lng: lng.toFixed(4), zoom: String(zoom), layers: LAYERS.join(',') });
    return `${COTRIP}?${query}`;
  }

  (typeof window !== 'undefined' ? window : globalThis).conditionsLinks = { cotripMapUrl, LAYERS };
})();
