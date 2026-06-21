// JWT auth middleware for Supabase-issued tokens.
//
// Supabase signs each JWT with the project's JWT secret (NOT the
// service_role key). We verify locally via the public JWKS endpoint —
// no round trip to Supabase per request.

import { createRemoteJWKSet, jwtVerify } from 'jose';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');

// Supabase exposes signing keys at /auth/v1/.well-known/jwks.json. The
// jose library caches keys and fetches lazily; one warm fetch per
// rotation interval.
const JWKS = SUPABASE_URL
  ? createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`))
  : null;

// HS256 secret for plugin-minted JWTs. Same secret on sign + verify; if
// missing we fall back to the service key so dev "just works".
function pluginSecret() {
  const s = process.env.PLUGIN_JWT_SECRET || process.env.SUPABASE_SERVICE_KEY || '';
  return s ? new TextEncoder().encode(s) : null;
}

// In dev (no auth required), set EARSHOT_AUTH=off to bypass.
const AUTH_ENABLED = (process.env.EARSHOT_AUTH || 'on').toLowerCase() !== 'off';

// We accept two flavours of token:
//   1. Supabase Auth JWTs (signed with the project's JWT secret, served
//      via JWKS) — issued to PWA users who clicked a magic link.
//   2. Plugin JWTs (HS256 with PLUGIN_JWT_SECRET) — issued via the
//      device-link flow so the plugin can sign in. Both end up with
//      the same `sub` (auth.users.id) so downstream code is identical.
export async function verifyJwt(token) {
  // Plugin tokens carry { plugin: true }. Try the cheap local-HS256 path
  // first; on any failure, fall back to JWKS for Supabase-issued tokens.
  const secret = pluginSecret();
  if (secret) {
    try {
      const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
      if (payload?.plugin === true) return payload;
    } catch { /* not a plugin token; try Supabase below */ }
  }

  if (!JWKS) throw new Error('SUPABASE_URL not set; cannot verify JWTs');
  const { payload } = await jwtVerify(token, JWKS, {
    requiredClaims: ['sub'],
  });
  return payload;
}

// Express middleware: pulls Bearer token, verifies, attaches req.userId.
// 401s on missing or invalid; 403s if the token is present but has no sub.
export function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) {
    // Dev pass-through. userId stays null — the DB layer treats null as
    // "ownerless / pre-auth data" and both backends include those rows
    // when filtering. Anything inserted in dev mode is also ownerless,
    // which keeps test data out of any real user's library.
    req.userId = null;
    return next();
  }

  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return res.status(401).json({ error: 'missing bearer token' });

  verifyJwt(m[1])
    .then(payload => {
      if (!payload.sub) return res.status(403).json({ error: 'token has no sub' });
      req.userId = payload.sub;
      req.userEmail = payload.email;
      next();
    })
    .catch(err => {
      console.warn('[earshot] jwt verify failed:', err.message);
      res.status(401).json({ error: 'invalid token' });
    });
}

// Optional auth — attaches userId if present, but doesn't reject if missing.
// Used by share-link routes that can be public AND owner-visible.
export function maybeAuth(req, _res, next) {
  if (!AUTH_ENABLED) { req.userId = null; return next(); }
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return next();
  verifyJwt(m[1])
    .then(payload => { req.userId = payload.sub; req.userEmail = payload.email; next(); })
    .catch(() => next()); // ignore bad tokens here
}
