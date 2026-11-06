// Verifies Cloudflare Access signed JWTs (the Cf-Access-Jwt-Assertion header) at the origin, so the
// app itself can insist on a valid Access sign-in instead of trusting only the tunnel and Access to
// block outsiders. Off unless both ACCESS_TEAM and ACCESS_AUD are set. No npm dependency: ES256
// verification is Node's crypto, and Cloudflare publishes its public keys as a plain JWKS.
import { createPublicKey, createVerify } from 'node:crypto';
import { isIP } from 'node:net';

const b64urlJson = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// Set both ACCESS_TEAM (the Zero Trust team name; keys at https://<team>.cloudflareaccess.com/cdn-cgi/access/certs)
// and ACCESS_AUD (the Access application's AUD tag), or neither. A bad configuration throws so the server fails closed.
export function loadAccessConfig(env = process.env) {
  const { ACCESS_TEAM, ACCESS_AUD } = env;
  if (!ACCESS_TEAM && !ACCESS_AUD) return null;
  if (!ACCESS_TEAM || !ACCESS_AUD) throw new Error('set both ACCESS_TEAM and ACCESS_AUD, or neither');
  if (!/^[a-z0-9-]{1,100}$/i.test(ACCESS_TEAM)) throw new Error('ACCESS_TEAM must be the Zero Trust team name (letters, digits, -)');
  if (!/^[a-f0-9]{16,128}$/i.test(ACCESS_AUD)) throw new Error('ACCESS_AUD must be the Access application\'s AUD tag');
  return { team: ACCESS_TEAM, aud: ACCESS_AUD };
}

// True when the address is anything a home network or the machine itself would use. Requests from
// such addresses (LAN visitors, nginx's own health probes, the container's health check) are exempt
// from Access verification; everything else is treated as having come through the tunnel.
export function isPublicAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
    return true;
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return false;
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped, e.g. ::ffff:192.168.0.5
    if (mapped) return isPublicAddress(mapped[1]);
    return true;
  }
  return false;
}

// A request counts as having arrived through the Cloudflare tunnel when the proxy reports a public
// visitor address (TRUST_PROXY=1, so nginx's X-Real-IP is trusted; nginx always overwrites the header,
// so a visitor can't claim to be on the LAN). Without the proxy, or with no public address, the
// request is exempt: the LAN route keeps working and the deploy's health check keeps passing.
export function requiresAccess(req, { trustProxy = false } = {}) {
  const ip = trustProxy ? req.headers['x-real-ip'] : null;
  return typeof ip === 'string' && ip.length > 0 && isPublicAddress(ip);
}

// Creates an async verifier: `await verify(req)` is true when the request carries a valid, current
// Cloudflare Access JWT for this team and application. Anything else (missing header, malformed,
// wrong key, wrong audience, expired, not-yet-valid) is false. Keys are fetched once and cached for
// the life of the process (Cloudflare rotates them rarely; a rotation is picked up on restart, which
// every deploy already does). `fetchImpl` lets the tests inject keys.
export function createAccessVerifier({ config, fetchImpl = fetch, now = () => Date.now(), leewayMs = 60_000 } = {}) {
  if (!config) return null;
  const issuer = `https://${config.team}.cloudflareaccess.com`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  let keys = null;

  const loadKeys = async () => {
    if (keys) return keys;
    const res = await fetchImpl(certsUrl);
    if (!res.ok) throw new Error(`could not load Access keys (status ${res.status})`);
    const jwks = await res.json();
    const loaded = new Map();
    for (const k of jwks.keys ?? []) {
      if (k.kid && k.alg === 'ES256') loaded.set(k.kid, createPublicKey({ key: k, format: 'jwk' }));
    }
    if (loaded.size === 0) throw new Error('no ES256 keys in the Access JWKS');
    keys = loaded;
    return keys;
  };

  return async (req) => {
    try {
      const token = req.headers['cf-access-jwt-assertion'];
      if (typeof token !== 'string' || !token) return false;
      const parts = token.split('.');
      if (parts.length !== 3) return false;
      const [h, p, s] = parts;
      const header = b64urlJson(h);
      const payload = b64urlJson(p);
      if (header.alg !== 'ES256' || typeof header.kid !== 'string') return false;
      const key = (await loadKeys()).get(header.kid);
      if (!key) return false;
      const signed = Buffer.from(`${h}.${p}`);
      if (!createVerify('SHA256').update(signed).verify(key, Buffer.from(s, 'base64url'))) return false;

      // Signature valid; now the claims.
      if (payload.iss !== issuer) return false;
      const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!auds.includes(config.aud)) return false;
      if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now() - leewayMs) return false;
      if (typeof payload.nbf === 'number' && payload.nbf * 1000 > now() + leewayMs) return false;
      if (typeof payload.iat === 'number' && payload.iat * 1000 > now() + leewayMs) return false;
      return true;
    } catch (e) {
      console.error(`Access verification failed: ${e.message}`);
      return false;
    }
  };
}
