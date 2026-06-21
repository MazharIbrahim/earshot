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

// In dev (no auth required), set EARSHOT_AUTH=off to bypass.
const AUTH_ENABLED = (process.env.EARSHOT_AUTH || 'on').toLowerCase() !== 'off';

export async function verifyJwt(token) {
  if (!JWKS) throw new Error('SUPABASE_URL not set; cannot verify JWTs');
  const { payload } = await jwtVerify(token, JWKS, {
    // 'authenticated' is the default role Supabase uses for signed-in users.
    requiredClaims: ['sub'],
  });
  return payload; // { sub, email, role, aud, exp, ... }
}

// Express middleware: pulls Bearer token, verifies, attaches req.userId.
// 401s on missing or invalid; 403s if the token is present but has no sub.
export function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) {
    // Dev pass-through. Use a single canonical 'dev user' id so all data
    // for the current developer lands in one bucket.
    req.userId = 'dev-user';
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
  if (!AUTH_ENABLED) { req.userId = 'dev-user'; return next(); }
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return next();
  verifyJwt(m[1])
    .then(payload => { req.userId = payload.sub; req.userEmail = payload.email; next(); })
    .catch(() => next()); // ignore bad tokens here
}
