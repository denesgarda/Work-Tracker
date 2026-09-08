// Verifies the JWT that Cloudflare Access injects on every authenticated
// request. Access already blocked unauthenticated traffic at the edge; this is
// defence in depth so that hitting the Worker route directly still fails.
//
// If ACCESS_TEAM_DOMAIN / ACCESS_AUD are unset (local `wrangler dev`), auth is
// skipped so the app is runnable without Zero Trust configured.

let jwksCache = { keys: null, fetchedAt: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000;

function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getKeys(teamDomain) {
  const now = Date.now();
  if (jwksCache.keys && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error('could not fetch Access JWKS');
  const { keys } = await res.json();
  jwksCache = { keys, fetchedAt: now };
  return keys;
}

// Returns the authenticated email, or null when the token is missing/invalid.
export async function verifyAccess(request, env) {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN || '').trim();
  const aud = (env.ACCESS_AUD || '').trim();
  if (!teamDomain || !aud) return { ok: true, email: 'local-dev', skipped: true };

  const cookie = request.headers.get('Cookie') || '';
  const fromCookie = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || fromCookie;
  if (!token) return { ok: false, reason: 'no token' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const [rawHeader, rawPayload, rawSig] = parts;

  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawHeader)));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(rawPayload)));
  } catch {
    return { ok: false, reason: 'undecodable token' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return { ok: false, reason: 'expired' };
  if (payload.nbf && payload.nbf > now + 60) return { ok: false, reason: 'not yet valid' };
  if (payload.iss !== `https://${teamDomain}`) return { ok: false, reason: 'bad issuer' };

  const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audList.includes(aud)) return { ok: false, reason: 'bad audience' };

  const keys = await getKeys(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: 'unknown signing key' };

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(rawSig),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );
  if (!valid) return { ok: false, reason: 'bad signature' };

  return { ok: true, email: payload.email || 'unknown' };
}
