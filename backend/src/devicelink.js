// Device-link auth flow for the plugin.
//
// The plugin can't run a browser, so we use the "device code" pattern
// (same as YouTube on TV, GitHub CLI, etc.):
//
//   1. Plugin POSTs /auth/device-code → backend mints a short 6-digit
//      user code + a longer device_id, and stores them paired in memory
//      with a TTL.
//   2. User opens app.earshot.cc/link on a signed-in browser, types the
//      6-digit code → PWA POSTs /auth/device-link with their JWT.
//   3. Backend marks the device_id as paired with the user's sub claim.
//   4. Plugin polls /auth/device-poll?device_id=X every 2s. When paired,
//      backend mints a long-lived (90-day) JWT scoped to that user_id and
//      returns it. Plugin stores in its host-saved state.
//
// The plugin's JWT carries the same `sub` as Supabase Auth, so the
// existing requireAuth middleware doesn't care which path issued it.

import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import express from 'express';
import { maybeAuth, requireAuth } from './auth.js';

// In-memory store. Single-instance Render service so this is fine for v1.
// If we ever scale horizontally, swap for Supabase Postgres (a table
// `device_codes`) or Redis.
const pending = new Map(); // device_id → { code, userId|null, expiresAt }
const CODE_TTL_MS = 10 * 60 * 1000;  // user has 10 min to redeem
const JWT_TTL = '90d';                // plugin keeps signing in for 90 days

function gc() {
  const now = Date.now();
  for (const [id, rec] of pending) if (rec.expiresAt < now) pending.delete(id);
}
setInterval(gc, 60_000);

function genCode() {
  // 6 digits, zero-padded. ~1M space; combined with the device_id check
  // and 10-min TTL the brute-force surface is negligible.
  return String(randomBytes(3).readUIntBE(0, 3) % 1_000_000).padStart(6, '0');
}

function genDeviceId() {
  return randomBytes(16).toString('hex');
}

// JWT signing key. JOSE wants a Uint8Array, not a string.
function signKey() {
  const s = process.env.PLUGIN_JWT_SECRET || process.env.SUPABASE_SERVICE_KEY || '';
  if (!s) throw new Error('PLUGIN_JWT_SECRET (or SUPABASE_SERVICE_KEY fallback) not set');
  return new TextEncoder().encode(s);
}

async function mintPluginJwt(userId, email) {
  return await new SignJWT({ email, plugin: true, role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(JWT_TTL)
    .sign(signKey());
}

export function mountDeviceLink(app) {
  const router = express.Router();

  // STEP 1 — plugin requests a fresh code/id pair.
  router.post('/device-code', (_req, res) => {
    const code = genCode();
    const deviceId = genDeviceId();
    pending.set(deviceId, { code, userId: null, expiresAt: Date.now() + CODE_TTL_MS });
    res.json({
      deviceId,
      code,
      expiresIn: CODE_TTL_MS / 1000,
      redeemUrl: `https://app.earshot.cc/link`,
    });
  });

  // STEP 2 — signed-in user redeems the code. Requires Bearer JWT.
  router.post('/device-link', requireAuth, (req, res) => {
    const code = String(req.body?.code || '').replace(/\D/g, '').slice(0, 6);
    if (code.length !== 6) return res.status(400).json({ error: 'invalid code' });

    let matched = null;
    for (const [id, rec] of pending) {
      if (rec.code === code && rec.expiresAt > Date.now()) { matched = { id, rec }; break; }
    }
    if (!matched) return res.status(404).json({ error: 'code not found or expired' });

    matched.rec.userId = req.userId;
    matched.rec.userEmail = req.userEmail || null;
    res.json({ ok: true });
  });

  // STEP 3 — plugin polls. Returns the JWT once the code is redeemed.
  router.get('/device-poll', async (req, res) => {
    const deviceId = String(req.query.deviceId || '');
    const rec = pending.get(deviceId);
    if (!rec) return res.status(404).json({ error: 'unknown device' });
    if (rec.expiresAt < Date.now()) {
      pending.delete(deviceId);
      return res.status(410).json({ error: 'expired' });
    }
    if (!rec.userId) return res.status(202).json({ status: 'pending' });

    // Paired — mint the long-lived token and clean up.
    try {
      const token = await mintPluginJwt(rec.userId, rec.userEmail);
      pending.delete(deviceId);
      res.json({ status: 'ready', token, userId: rec.userId, email: rec.userEmail });
    } catch (e) {
      console.error('[earshot] device-link mint failed:', e.message);
      res.status(500).json({ error: 'mint failed' });
    }
  });

  app.use('/auth', router);
}
