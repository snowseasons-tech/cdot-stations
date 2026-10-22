// Small geography helpers for saved station positions.

const EARTH_RADIUS_MILES = 3958.8;
const toRadians = (degrees) => (degrees * Math.PI) / 180;

// Great-circle distance in miles between two { lat, lng } points.
export function distanceMiles(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

// A box around Colorado (a little generous). It catches the usual typing mistakes: swapped latitude and longitude,
// a missing minus sign, a dropped digit.
export const COLORADO_BOUNDS = { south: 36.9, north: 41.1, west: -109.1, east: -101.9 };

export const inColorado = ({ lat, lng }) =>
  lat >= COLORADO_BOUNDS.south && lat <= COLORADO_BOUNDS.north && lng >= COLORADO_BOUNDS.west && lng <= COLORADO_BOUNDS.east;

// The mean of several points, which is where a station's single "port" circle on the inspection map is drawn.
export const centroid = (points) => ({
  lat: points.reduce((n, p) => n + p.lat, 0) / points.length,
  lng: points.reduce((n, p) => n + p.lng, 0) / points.length,
});
