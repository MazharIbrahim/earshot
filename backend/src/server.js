// Earshot local backend.
//
// Same shape as the eventual cloud service (Supabase + R2/S3):
//   POST   /takes              multipart upload, fields: project, durationSec
//   GET    /projects           list distinct projects, with take count + latest
//   GET    /projects/:id/takes list takes for a project (id = slugified name)
//   GET    /takes/:id/audio    stream the WAV (Range supported by express.static-style)
//   GET    /healthz            { ok: true }
//
// Storage:
//   data/earshot.db     SQLite (metadata)
//   data/audio/*.wav    raw take files (uuid named)

import 'express-async-errors';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { nanoid } from 'nanoid';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTunnel } from './tunnel.js';
import { transcodeToOpus } from './transcode.js';
import { getStorage } from './storage.js';
import { openDb } from './db.js';
import { requireAuth, maybeAuth } from './auth.js';
import { mountDeviceLink } from './devicelink.js';
import { sendMail, collabInviteEmail } from './mailer.js';
import { createCheckout, verifyWebhookSignature, tierFromWebhook } from './billing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, '..', 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// DB chosen by EARSHOT_DB env (sqlite default, supabase opt-in). Both
// expose the same camelCase API — see src/db.js.
const db = await openDb();

const slug = (s) => (s || 'untitled')
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '') || 'untitled';

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json());

// Light request log so we can see what the plugin is actually sending.
// Pre-auth so we capture 401s too.
app.use((req, _res, next) => {
  if (req.path.startsWith('/takes') || req.path.startsWith('/auth')) {
    const ip = req.get('cf-connecting-ip') || req.ip;
    const auth = req.get('authorization') ? 'bearer' : '-';
    const idem = req.get('x-earshot-idempotency') || '-';
    console.log(`[req] ${req.method} ${req.path}  ip=${ip}  auth=${auth}  idem=${idem.slice(0,30)}`);
  }
  next();
});

// Serve the built PWA at the root. Backend and frontend share one origin
// so the PWA can use relative URLs and one Cloudflare tunnel covers both.
const WEB_DIST = path.join(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST));
}

const upload = multer({
  storage: multer.diskStorage({
    destination: AUDIO_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.wav';
      cb(null, nanoid() + ext);
    },
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB per take
});

// Public URL state — set once the Cloudflare tunnel comes up.
let tunnelStatus = { state: 'starting', publicUrl: null };

app.get('/healthz', (_req, res) => res.json({
  ok: true,
  tunnel: tunnelStatus.state,
  publicUrl: tunnelStatus.publicUrl,
}));

mountDeviceLink(app);

// Tiny "who am I" endpoint. The plugin calls it after sign-in to learn
// the user's email/handle for display in the top-right of the editor.
app.get('/auth/me', requireAuth, (req, res) => {
  res.json({ userId: req.userId, email: req.userEmail || null });
});

// ---------- Share tokens ----------
// Owner creates a token for one of their takes. Anyone with the token URL
// can view that take (and its comments). Sign-in required to comment.

app.post('/takes/:id/share', requireAuth, async (req, res) => {
  // Ownership check — only the take's owner can mint a share.
  const files = await db.getTakeFiles(req.params.id);
  if (!files) return res.status(404).end();
  if (files.userId && files.userId !== req.userId) return res.status(403).end();

  const token = await db.createShareToken(req.params.id, req.userId);
  if (!token) return res.status(500).json({ error: 'failed to create share' });

  // Optional: also drop it in the recipient's inbox so they see it
  // in their library, not just via the URL.
  const recipientEmail = String(req.body?.recipientEmail || '').trim().toLowerCase();
  if (recipientEmail.includes('@')) {
    try { await db.addShareRecipient(token, recipientEmail); }
    catch (e) { console.warn('[earshot] add share recipient:', e.message); }
  }

  res.json({
    token,
    url: `https://app.earshot.cc/s/${token}`,
    recipientEmail: recipientEmail.includes('@') ? recipientEmail : null,
  });
});

app.delete('/share/:token', requireAuth, async (req, res) => {
  const ok = await db.revokeShare(req.params.token, req.userId);
  if (!ok) return res.status(404).end();
  res.json({ ok: true });
});

// Public: anyone with the token sees the take. Returns the take + a
// signed audio URL. No auth required.
app.get('/share/:token', async (req, res) => {
  const share = await db.getShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'unknown or revoked share' });
  if (share.expires_at && share.expires_at < Date.now()) {
    return res.status(410).json({ error: 'share expired' });
  }
  const take = await db.getTakeById(share.take_id);
  if (!take) return res.status(404).json({ error: 'take not found' });
  res.json({
    take,
    // Audio endpoint already supports public access, the share token
    // just gives the recipient the take's id to play with.
    audioUrl: `/takes/${take.id}/audio`,
  });
});

// ---------- Comments ----------
// Comments are visible to:
//   - the take's owner (always)
//   - anyone holding an active share token to that take (via /share/:token/comments)
//
// Writing always requires a signed-in account. We don't allow anonymous
// comments — at minimum the writer needs an email on file. Lowers spam
// surface; recipients sign up if they want to leave a comment.

app.get('/takes/:id/comments', requireAuth, async (req, res) => {
  // Allow the owner AND any collaborator on the project — same access
  // rules as viewing the take itself.
  const acc = await db.canAccessTake(req.params.id, req.userId, req.userEmail);
  if (!acc.ok) return res.status(acc.code || 403).end();
  res.json(await db.listComments(req.params.id));
});

// Read comments via a share token (public).
app.get('/share/:token/comments', async (req, res) => {
  const share = await db.getShare(req.params.token);
  if (!share) return res.status(404).end();
  res.json(await db.listComments(share.take_id));
});

// Post a comment to a take you own OR are a member of.
app.post('/takes/:id/comments', requireAuth, async (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'empty comment' });
  const t = req.body?.timestampSec;
  const timestampSec = typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : null;

  const acc = await db.canAccessTake(req.params.id, req.userId, req.userEmail);
  if (!acc.ok) return res.status(acc.code || 403).end();

  const row = await db.insertComment(req.params.id, req.userId, req.userEmail, text, timestampSec);
  if (!row) return res.status(500).end();
  res.json(row);
});

// Post a comment via a share token — for non-owner recipients. Still
// requires the writer to be signed in (we attribute by user_id).
app.post('/share/:token/comments', requireAuth, async (req, res) => {
  const share = await db.getShare(req.params.token);
  if (!share) return res.status(404).end();
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'empty comment' });
  const t = req.body?.timestampSec;
  const timestampSec = typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : null;

  const row = await db.insertComment(share.take_id, req.userId, req.userEmail, text, timestampSec);
  if (!row) return res.status(500).end();
  res.json(row);
});

// Delete your own comment.
app.delete('/comments/:id', requireAuth, async (req, res) => {
  const ok = await db.deleteComment(req.params.id, req.userId);
  if (!ok) return res.status(404).end();
  res.json({ ok: true });
});

// ---------- Profile / tier ----------
//
// Profiles are lazily created on first /profile call. Tier upgrades come
// from a (future) Stripe webhook; for now everyone is 'free'.
app.get('/profile', requireAuth, async (req, res) => {
  let prof = await db.getProfile(req.userId);
  if (!prof) {
    await db.upsertProfile(req.userId, req.userEmail || null);
    prof = await db.getProfile(req.userId);
    // Newly visible profile — backfill any pending member invites.
    if (req.userEmail) {
      await db.claimPendingMemberships(req.userId, req.userEmail);
    }
  }
  res.json(prof);
});

// ---------- Free-tier enforcement (soft) ----------
// Currently: max 3 active projects. Anything else (retention, take size)
// is informational on the client side until we wire it server-side.
const FREE_TIER_PROJECT_CAP = 3;

async function isWithinTierLimits(userId, projectSlug) {
  const prof = await db.getProfile(userId);
  if (prof && prof.tier !== 'free') return { ok: true };

  // Free users get up to N distinct projects. Once they have N, they
  // can keep adding takes to existing ones but not create a new one.
  const existing = await db.countUserProjects(userId);
  // Adding a take to an EXISTING project doesn't count as "new".
  const projects = (await db.allTakes()).filter(t => /* same user check happens implicitly via DB scoping */ true);
  // Easier check: do they already have any take in this slug?
  const rows = await (async () => {
    try {
      const r = await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/takes?select=id&user_id=eq.${encodeURIComponent(userId)}&project_id=eq.${encodeURIComponent(projectSlug)}&limit=1`,
        { headers: {
          apikey: process.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        }});
      return r.ok ? await r.json() : [];
    } catch { return []; }
  })();
  if (rows.length > 0) return { ok: true }; // existing project, no problem
  if (existing >= FREE_TIER_PROJECT_CAP) {
    return { ok: false, reason: `Free tier limited to ${FREE_TIER_PROJECT_CAP} projects. Upgrade to Pro for unlimited.` };
  }
  return { ok: true };
}

// Limit check is invoked from the multipart-init handler directly,
// see isWithinTierLimits there.


// ---------- Project members (collaborators) ----------
app.get('/projects/:id/members', requireAuth, async (req, res) => {
  // List members for a project the user owns.
  res.json(await db.listProjectMembers(req.userId, req.params.id));
});

app.post('/projects/:id/members', requireAuth, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = ['viewer', 'commenter', 'editor'].includes(req.body?.role)
    ? req.body.role : 'viewer';
  if (!email.includes('@')) return res.status(400).json({ error: 'invalid email' });
  const row = await db.addProjectMember(req.userId, req.params.id, email, role);

  // Best-effort: if a user with this email already exists, attach their
  // user_id immediately so the invite is "live" without needing a sign-in.
  try {
    const r = await fetch(
      `${process.env.SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
      { headers: { apikey: process.env.SUPABASE_SERVICE_KEY,
                   Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` }});
    if (r.ok) {
      const body = await r.json();
      const u = body.users?.[0] || body[0];
      if (u?.id) {
        await db.claimPendingMemberships(u.id, email);
      }
    }
  } catch {/* non-fatal */}

  // Fire the invite email (no-op when EARSHOT_MAILER=off, which is the
  // current default until Resend is set up).
  const projectName = (req.body?.projectName || req.params.id).toString().slice(0, 200);
  const inviteUrl = `https://app.earshot.cc/p/${encodeURIComponent(req.params.id)}`;
  const { subject, text, html } = collabInviteEmail({
    inviterEmail: req.userEmail || 'A collaborator',
    projectName,
    inviteUrl,
  });
  sendMail({ to: email, subject, html, text }).catch(() => {});

  res.json(row);
});

app.delete('/projects/:id/members/:email', requireAuth, async (req, res) => {
  const ok = await db.removeProjectMember(req.userId, req.params.id,
                                          decodeURIComponent(req.params.email));
  if (!ok) return res.status(404).end();
  res.json({ ok: true });
});

// ---------- Shared-with-me inbox ----------
// Returns the share tokens addressed to the user's email — basically the
// list of takes someone else made and pointed at this user.
app.get('/shared-with-me', requireAuth, async (req, res) => {
  if (!req.userEmail) return res.json([]);
  // Also claim any pending project memberships waiting on this email.
  await db.claimPendingMemberships(req.userId, req.userEmail);
  res.json(await db.listInbox(req.userEmail));
});

// Share recipient is handled inline in POST /takes/:id/share above.


// ---------- Billing (LemonSqueezy) ----------
//
// POST /billing/checkout : authenticated user → returns LS checkout URL.
// POST /billing/webhook  : LS calls this with subscription lifecycle
//                          events. We verify the HMAC and update tier.

app.post('/billing/checkout', requireAuth, async (req, res) => {
  const variantId = process.env.LEMONSQUEEZY_PRO_VARIANT_ID;
  const storeId   = process.env.LEMONSQUEEZY_STORE_ID;
  if (!variantId || !storeId) {
    return res.status(501).json({
      error: 'billing not configured',
      detail: 'LEMONSQUEEZY_PRO_VARIANT_ID + LEMONSQUEEZY_STORE_ID needed',
    });
  }
  try {
    const url = await createCheckout({
      userId: req.userId,
      email: req.userEmail,
      variantId, storeId,
    });
    if (!url) return res.status(500).json({ error: 'checkout url missing' });
    res.json({ url });
  } catch (e) {
    console.error('[billing] checkout:', e.message);
    res.status(500).json({ error: 'checkout failed' });
  }
});

// LS webhook. The global express.json() middleware would parse + lose
// the raw body, so we mount a raw parser specifically for this route.
app.post('/billing/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  async (req, res) => {
    const sig = req.get('x-signature') || '';
    const raw = req.body; // Buffer
    if (!verifyWebhookSignature(raw, sig)) {
      console.warn('[billing] webhook bad signature');
      return res.status(401).end();
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); }
    catch { return res.status(400).end(); }

    const event = req.get('x-event-name')
                 || payload?.meta?.event_name || '';
    const customUserId = payload?.meta?.custom_data?.user_id
                       || payload?.data?.attributes?.first_subscription_item?.custom_data?.user_id
                       || null;
    const tier = tierFromWebhook(event, payload);
    console.log(`[billing] event=${event} tier=${tier} user=${customUserId}`);

    if (tier && customUserId) {
      const extra = tier === 'pro' ? { pro_since: Date.now() } : {};
      try { await db.setProfileTier(customUserId, tier, extra); }
      catch (e) { console.error('[billing] setProfileTier:', e.message); }
    }

    res.json({ ok: true }); // always 200 so LS doesn't retry on our bugs
  });


// --- Direct-to-R2 upload flow ------------------------------------------
//
// Render Free has a 100s request timeout. A 4-min stereo WAV (~46 MB)
// on a typical home upload doesn't fit. So the plugin uploads straight
// to R2 with a presigned PUT URL, never routing the audio bytes
// through Render. Two small JSON requests bracket the big PUT.
//
//   1. POST /takes/upload-url  → backend mints { takeId, uploadUrl }
//   2. plugin PUTs WAV to uploadUrl
//   3. POST /takes/upload-complete → backend inserts the take row
//
// Idempotency from the X-Earshot-Idempotency header still applies to
// the upload-url step; retrying a complete is a no-op via the same key.

app.post('/takes/upload-url', requireAuth, async (req, res) => {
  const project = (req.body?.project || 'Untitled').toString().slice(0, 200);
  const projectId = slug(project);
  const duration = Number(req.body?.durationSec) || 0;
  const idemKey = (req.get('x-earshot-idempotency') || '').slice(0, 200) || null;

  if (idemKey) {
    const existing = await db.findByIdempotency(idemKey, req.userId);
    if (existing) {
      return res.json({
        deduped: true,
        takeId: existing.id,
        project: existing.project,
        projectId: existing.projectId,
        durationSec: existing.durationSec,
        createdAt: existing.createdAt,
      });
    }
  }

  const takeId = nanoid();
  const wavKey = `${takeId}.wav`;
  const storage = await getStorage();

  if (!storage.presignPut) {
    return res.status(501).json({ error: 'storage backend does not support presigned uploads' });
  }
  try {
    const uploadUrl = await storage.presignPut(wavKey, 'audio/wav');
    res.json({
      takeId,
      wavKey,
      uploadUrl,
      project, projectId, durationSec: duration,
      idempotencyKey: idemKey,
    });
  } catch (e) {
    console.error('[earshot] presign failed:', e.message);
    res.status(500).json({ error: 'presign failed' });
  }
});

// --- Multipart upload (big files) -------------------------------------
//
// For takes whose WAV is bigger than ~10 MB, a single PUT to R2 over a
// slow uplink either hangs in the OS socket layer or hits some
// intermediate idle timeout. Multipart upload splits the WAV into 8 MB
// parts; each part is its own PUT with its own presigned URL. Plugin
// can show real progress and retry individual parts.
//
//   1. POST /takes/multipart/init     → { takeId, wavKey, uploadId, partSize }
//   2. POST /takes/multipart/sign-part → { url } for partNumber=N
//   3. plugin uploads each part to its signed URL, collects ETags
//   4. POST /takes/multipart/complete  with { uploadId, parts, ... }

app.post('/takes/multipart/init', requireAuth, async (req, res) => {
  const project = (req.body?.project || 'Untitled').toString().slice(0, 200);
  const projectId = slug(project);
  const duration = Number(req.body?.durationSec) || 0;
  const idemKey = (req.get('x-earshot-idempotency') || '').slice(0, 200) || null;

  if (idemKey) {
    const existing = await db.findByIdempotency(idemKey, req.userId);
    if (existing) {
      return res.json({
        deduped: true,
        takeId: existing.id, project: existing.project,
        projectId: existing.projectId, durationSec: existing.durationSec,
      });
    }
  }

  // Free tier: 3 projects max. Skip if env opts out (useful for tests).
  if ((process.env.EARSHOT_ENFORCE_TIER || 'on').toLowerCase() !== 'off') {
    const check = await isWithinTierLimits(req.userId, projectId);
    if (!check.ok) return res.status(402).json({ error: check.reason });
  }

  const takeId = nanoid();
  const wavKey = `${takeId}.wav`;
  const storage = await getStorage();
  if (!storage.multipartCreate) {
    return res.status(501).json({ error: 'multipart not supported by storage backend' });
  }
  try {
    const uploadId = await storage.multipartCreate(wavKey, 'audio/wav');
    res.json({
      takeId, wavKey, uploadId,
      // 5 MB chunks: S3 multipart's minimum-per-non-final-part. Smaller
      // = faster individual PUT completion on slow uplinks = harder for
      // intermediate idle timeouts to fire mid-chunk.
      partSize: 5 * 1024 * 1024,
      project, projectId, durationSec: duration,
      idempotencyKey: idemKey,
    });
  } catch (e) {
    console.error('[earshot] multipart init failed:', e.message);
    res.status(500).json({ error: 'multipart init failed' });
  }
});

app.post('/takes/multipart/sign-part', requireAuth, async (req, res) => {
  const { wavKey, uploadId, partNumber } = req.body || {};
  if (!wavKey || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return res.status(400).json({ error: 'bad part request' });
  }
  const storage = await getStorage();
  try {
    const url = await storage.presignPart(wavKey, uploadId, partNumber);
    res.json({ url });
  } catch (e) {
    console.error('[earshot] sign-part failed:', e.message);
    res.status(500).json({ error: 'sign failed' });
  }
});

app.post('/takes/multipart/complete', requireAuth, async (req, res) => {
  const b = req.body || {};
  const takeId  = String(b.takeId || '');
  const wavKey  = String(b.wavKey || '');
  const uploadId = String(b.uploadId || '');
  const parts   = Array.isArray(b.parts) ? b.parts : null;
  const project = (b.project || 'Untitled').toString().slice(0, 200);
  const projectId = slug(project);
  const duration = Number(b.durationSec) || 0;
  const bytes = Number(b.bytes) || 0;
  const idemKey = (b.idempotencyKey || null) || null;

  if (!takeId || !wavKey || !uploadId || !parts || !parts.length) {
    return res.status(400).json({ error: 'missing fields' });
  }

  const storage = await getStorage();
  try {
    await storage.multipartComplete(wavKey, uploadId, parts.map(p => ({
      PartNumber: p.partNumber, ETag: p.etag,
    })));
  } catch (e) {
    console.error('[earshot] multipart complete failed:', e.message);
    return res.status(502).json({ error: 'storage complete failed', detail: e.message });
  }

  const now = Date.now();
  try {
    await db.insertTake({
      id: takeId, project, projectId,
      filename: wavKey, opusFilename: null,
      durationSec: duration, bytes,
      createdAt: now, idempotencyKey: idemKey,
    }, req.userId);
  } catch (e) {
    if (/duplicate|unique|constraint/i.test(e.message)) {
      return res.json({ takeId, deduped: true });
    }
    throw e;
  }

  res.json({
    id: takeId, project, projectId,
    durationSec: duration, bytes,
    opus: false, createdAt: now,
  });

  // Same async transcode hand-off as the single-PUT flow.
  const wavPath = path.join(AUDIO_DIR, wavKey);
  const opusKey = wavKey.replace(/\.[^.]+$/, '') + '.opus';
  const opusPath = path.join(AUDIO_DIR, opusKey);
  (async () => {
    try {
      const r = await fetch(storage.url(wavKey));
      if (!r.ok) throw new Error(`download ${wavKey} → ${r.status}`);
      await fs.promises.writeFile(wavPath, Buffer.from(await r.arrayBuffer()));
      await transcodeToOpus(wavPath, opusPath, { bitrateKbps: 128 });
      await storage.put(opusKey, opusPath, 'audio/ogg');
      await db.setOpusFilename(takeId, opusKey);
      console.log(`[earshot] async transcode done for ${takeId}`);
    } catch (e) {
      console.error(`[earshot] async transcode failed for ${takeId}:`, e.message);
    } finally {
      try { fs.unlinkSync(wavPath); } catch {}
      try { fs.unlinkSync(opusPath); } catch {}
    }
  })();
});

// Abort endpoint for cleanup if plugin crashes mid-upload.
app.post('/takes/multipart/abort', requireAuth, async (req, res) => {
  const { wavKey, uploadId } = req.body || {};
  if (!wavKey || !uploadId) return res.status(400).end();
  const storage = await getStorage();
  await storage.multipartAbort(wavKey, uploadId);
  res.json({ ok: true });
});

app.post('/takes/upload-complete', requireAuth, async (req, res) => {
  const body = req.body || {};
  const takeId = String(body.takeId || '');
  const wavKey = String(body.wavKey || `${takeId}.wav`);
  const project = (body.project || 'Untitled').toString().slice(0, 200);
  const projectId = slug(project);
  const duration = Number(body.durationSec) || 0;
  const bytes = Number(body.bytes) || 0;
  const idemKey = (body.idempotencyKey || null) || null;

  if (!takeId) return res.status(400).json({ error: 'takeId required' });

  // Belt and suspenders: verify the object actually landed in R2 before
  // we add the DB row. Otherwise a half-aborted upload would create a
  // ghost take that 404s on play.
  const storage = await getStorage();
  if (!(await storage.exists(wavKey))) {
    return res.status(409).json({ error: 'upload not found in storage', wavKey });
  }

  const now = Date.now();
  try {
    await db.insertTake({
      id: takeId, project, projectId,
      filename: wavKey,
      opusFilename: null,    // backend transcodes async (see below)
      durationSec: duration,
      bytes,
      createdAt: now,
      idempotencyKey: idemKey,
    }, req.userId);
  } catch (e) {
    // PRIMARY KEY (id) or UNIQUE (idempotency_key) collision means the
    // upload was already confirmed once; treat as a successful retry.
    if (/duplicate|unique|constraint/i.test(e.message)) {
      return res.json({ takeId, deduped: true });
    }
    throw e;
  }

  res.json({
    id: takeId, project, projectId,
    durationSec: duration, bytes,
    opus: false,
    createdAt: now,
  });

  // Best-effort async transcode. Free-tier Render struggles but it'll
  // eventually finish; until it does, the audio endpoint serves the WAV.
  // If this fails the take is still usable, just bigger to stream.
  (async () => {
    const wavPath = path.join(AUDIO_DIR, wavKey);
    const opusKey = wavKey.replace(/\.[^.]+$/, '') + '.opus';
    const opusPath = path.join(AUDIO_DIR, opusKey);
    try {
      // Download the WAV from R2 to local disk for ffmpeg.
      const r = await fetch(storage.url(wavKey));
      if (!r.ok) throw new Error(`download ${wavKey} → ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      await fs.promises.writeFile(wavPath, buf);

      await transcodeToOpus(wavPath, opusPath, { bitrateKbps: 128 });
      await storage.put(opusKey, opusPath, 'audio/ogg');
      await db.setOpusFilename(takeId, opusKey);
      console.log(`[earshot] async transcode done for ${takeId}`);
    } catch (e) {
      console.error(`[earshot] async transcode failed for ${takeId}:`, e.message);
    } finally {
      try { fs.unlinkSync(wavPath); } catch {}
      try { fs.unlinkSync(opusPath); } catch {}
    }
  })();
});

// POST /takes — multipart: file=audio, fields: project, durationSec.
// Optional header X-Earshot-Idempotency: a client-chosen unique string per
// take. If the same key arrives twice (because the plugin retried after a
// dropped response), we treat the second POST as a no-op and return the
// existing take's metadata. This is the only thing standing between a
// flaky upload and 47 duplicate rows for one recording.
app.post('/takes', requireAuth, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required' });

  const idemKey = (req.get('x-earshot-idempotency') || '').slice(0, 200) || null;

  if (idemKey) {
    const existing = await db.findByIdempotency(idemKey, req.userId);
    if (existing) {
      // Already have it. Throw away the just-uploaded WAV so we don't
      // accumulate orphan files on disk.
      try { fs.unlinkSync(path.join(AUDIO_DIR, req.file.filename)); } catch {}
      console.log(`[earshot] duplicate upload (idempotency=${idemKey}) — returning existing ${existing.id}`);
      return res.json({
        id: existing.id,
        project: existing.project,
        projectId: existing.projectId,
        durationSec: existing.durationSec,
        bytes: existing.bytes,
        createdAt: existing.createdAt,
        opus: !!existing.opusFilename,
        deduped: true,
      });
    }
  }

  const project = (req.body.project || 'Untitled').toString().slice(0, 200);
  const projectId = slug(project);
  const duration = Number(req.body.durationSec) || 0;
  const id = nanoid();
  const wavPath = path.join(AUDIO_DIR, req.file.filename);
  const opusName = req.file.filename.replace(/\.[^.]+$/, '') + '.opus';
  const opusPath = path.join(AUDIO_DIR, opusName);

  // Insert the take row first, *without* opus_filename. Plugin gets
  // its 200 the moment the WAV is on disk — typical 4-min take goes
  // from minutes (sync transcode + R2 push) down to ~upload time.
  const now = Date.now();
  await db.insertTake({
    id, project, projectId,
    filename: req.file.filename,
    opusFilename: null,
    durationSec: duration,
    bytes: req.file.size,
    createdAt: now,
    idempotencyKey: idemKey,
  }, req.userId);

  res.json({
    id, project, projectId,
    durationSec: duration,
    bytes: req.file.size,
    opus: false,           // not yet — finished in background
    createdAt: now,
  });

  // Fire-and-forget: transcode + push to R2 + flip opus_filename.
  // Until that finishes, the audio endpoint serves the local WAV.
  const uploadWav = (process.env.EARSHOT_UPLOAD_WAV || 'false').toLowerCase() === 'true';
  (async () => {
    try {
      await transcodeToOpus(wavPath, opusPath, { bitrateKbps: 128 });
      console.log(`[earshot] transcoded ${req.file.filename} -> ${opusName}`
        + ` (${(fs.statSync(opusPath).size / 1024).toFixed(1)} KB`
        + ` vs ${(req.file.size / 1024).toFixed(1)} KB WAV)`);

      const storage = await getStorage();
      if (storage.kind !== 'local') {
        await storage.put(opusName, opusPath, 'audio/ogg');
        if (uploadWav) await storage.put(req.file.filename, wavPath, 'audio/wav');
      }
      await db.setOpusFilename(id, opusName);

      // Free Render's disk — 750 MB is the free-tier limit. Once Opus
      // is in R2 we don't need the WAV here anymore (download-original
      // would re-fetch from R2 if we ever push it there too).
      try { fs.unlinkSync(wavPath); } catch {}
      try { fs.unlinkSync(opusPath); } catch {}
    } catch (e) {
      console.error(`[earshot] async post-upload failed for ${id}:`, e.message);
    }
  })();
});

app.get('/projects', requireAuth, async (req, res) => {
  res.json(await db.listProjects(req.userId, req.userEmail || null));
});

app.get('/projects/:id/takes', requireAuth, async (req, res) => {
  res.json(await db.listTakes(req.params.id, req.userId, req.userEmail || null));
});

// DELETE /takes/:id — remove from storage + DB. Idempotent: a 404 is
// fine if it's already gone.
app.delete('/takes/:id', requireAuth, async (req, res) => {
  const files = await db.getTakeFiles(req.params.id);
  if (!files) return res.status(404).end();
  // Don't let a user delete another user's take just because they know
  // the URL. Owner check first.
  if (files.userId && files.userId !== req.userId) {
    return res.status(403).end();
  }

  const storage = await getStorage();
  for (const name of [files.filename, files.opusFilename].filter(Boolean)) {
    try { await storage.remove(name); }
    catch (e) { console.error(`[earshot] delete from storage failed for ${name}:`, e.message); }
    const local = path.join(AUDIO_DIR, name);
    if (fs.existsSync(local)) {
      try { fs.unlinkSync(local); } catch {}
    }
  }

  await db.deleteTake(req.params.id, req.userId);
  res.json({ ok: true });
});

// PATCH /takes/:id — update editable fields (currently just note).
app.patch('/takes/:id', requireAuth, async (req, res) => {
  const note = typeof req.body.note === 'string'
    ? req.body.note.slice(0, 200)
    : null;
  const ok = await db.updateNote(req.params.id, note, req.userId);
  if (!ok) return res.status(404).end();
  res.json({ ok: true });
});

// GET /takes/:id/audio
// Default: Opus (12x smaller, near-instant start on mobile).
// ?format=wav: original lossless WAV (for archival download, Pro feature).
// When remote storage exposes a public URL, redirect there (R2 free egress).
app.get('/takes/:id/audio', async (req, res) => {
  const files = await db.getTakeFiles(req.params.id);
  if (!files) return res.status(404).end();

  const wantWav = req.query.format === 'wav';
  const filename = !wantWav && files.opusFilename ? files.opusFilename : files.filename;
  const isOpus = filename.endsWith('.opus');

  const storage = await getStorage();

  // Remote storage with a public URL: only redirect there if the object
  // actually exists. By default we no longer upload WAVs to R2, so
  // ?format=wav has to fall through to the local disk copy.
  const remoteUrl = storage.url(filename);
  if (remoteUrl && await storage.exists(filename)) {
    return res.redirect(302, remoteUrl);
  }

  // Local disk fallback.
  const filePath = path.join(AUDIO_DIR, filename);
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', isOpus ? 'audio/ogg' : 'audio/wav');
    res.setHeader('Accept-Ranges', 'bytes');
    return res.sendFile(filePath);
  }

  // Last resort: if Opus wasn't found in either place, try the WAV.
  if (filename !== files.filename) {
    const wavFallback = path.join(AUDIO_DIR, files.filename);
    if (fs.existsSync(wavFallback)) {
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Accept-Ranges', 'bytes');
      return res.sendFile(wavFallback);
    }
  }
  res.status(404).end();
});

// SPA fallback: anything that wasn't an API route or a static file gets
// the PWA's index.html so React Router handles client-side routing.
app.get(/^\/(?!projects|takes|healthz).*/, (_req, res, next) => {
  const indexFile = path.join(WEB_DIST, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  next();
});

// Catch-all error handler. Without this, an async handler throwing (e.g.
// a PostgREST 400 because schema is mid-migration) takes down the whole
// Node process. We want a 500 + logged error instead.
app.use((err, req, res, _next) => {
  console.error(`[earshot] ${req.method} ${req.url}:`, err.message);
  if (!res.headersSent) res.status(500).json({ error: err.message });
});

process.on('unhandledRejection', (reason) => {
  console.error('[earshot] unhandledRejection:', reason);
});

// Prune DB rows whose audio doesn't exist in storage. This happens when
// uploads silently failed in older code paths (the EPIPE era). Idempotent.
async function pruneOrphans() {
  const storage = await getStorage();
  if (storage.kind === 'local') return; // local always-present
  const rows = await db.allTakes();
  let pruned = 0;
  for (const r of rows) {
    // Since we stopped uploading WAVs to R2 by default, the existence
    // check that matters is the Opus. A row counts as good if either is
    // in storage OR the WAV is still on local disk (the local fallback
    // path in the audio handler will serve it).
    const hasOpus = r.opusFilename ? await storage.exists(r.opusFilename) : false;
    const hasWav  = await storage.exists(r.filename);
    const localWav = fs.existsSync(path.join(AUDIO_DIR, r.filename));
    if (hasOpus || hasWav || localWav) continue;
    await db.deleteTake(r.id);
    pruned++;
  }
  if (pruned > 0) console.log(`[earshot] pruned ${pruned} orphan take row(s)`);
}

// Push every local audio file referenced by the DB to remote storage if
// it isn't already there. Idempotent — runs at startup so cloud is in
// sync after a migration or when the storage backend changes.
async function backfillCloud() {
  const storage = await getStorage();
  if (storage.kind === 'local') return;
  const rows = await db.allTakes();
  let uploaded = 0;
  for (const row of rows) {
    // Only the Opus is needed in remote storage for playback. WAVs stay
    // on the local disk; we wouldn't want to silently re-upload a 25 MB
    // WAV at boot just because it sits next to its Opus.
    if (!row.opusFilename) continue;
    try {
      if (await storage.exists(row.opusFilename)) continue;
      const local = path.join(AUDIO_DIR, row.opusFilename);
      if (!fs.existsSync(local)) continue;
      await storage.put(row.opusFilename, local, 'audio/ogg');
      uploaded++;
    } catch (e) {
      console.error(`[earshot] cloud backfill failed for ${row.opusFilename}:`, e.message);
    }
  }
  if (uploaded > 0) {
    console.log(`[earshot] cloud backfill: pushed ${uploaded} file(s) to ${storage.kind}`);
  }
}

// Background backfill: takes uploaded before transcoding was added get a
// .opus next to their .wav. Runs sequentially with low priority so we
// don't fight live uploads.
async function backfillOpus() {
  const rows = (await db.allTakes()).filter(r => !r.opusFilename);
  if (rows.length === 0) return;
  console.log(`[earshot] backfill: ${rows.length} take(s) need transcoding`);

  for (const row of rows) {
    const wavPath = path.join(AUDIO_DIR, row.filename);
    if (!fs.existsSync(wavPath)) continue;
    const opusName = row.filename.replace(/\.[^.]+$/, '') + '.opus';
    const opusPath = path.join(AUDIO_DIR, opusName);
    try {
      await transcodeToOpus(wavPath, opusPath, { bitrateKbps: 128 });
      await db.setOpusFilename(row.id, opusName);
      console.log(`[earshot] backfilled ${row.filename}`);
    } catch (e) {
      console.error(`[earshot] backfill failed for ${row.filename}:`, e.message);
    }
  }
}

const PORT = process.env.PORT || 8787;
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[earshot] backend listening on http://localhost:${PORT}`);
  await getStorage(); // logs which backend is in use
  tunnelStatus = startTunnel({
    port: PORT,
    onUrl: (url) => { tunnelStatus.publicUrl = url; tunnelStatus.state = 'running'; },
  });
  // Fire-and-forget; logs progress.
  backfillOpus()
    .then(() => backfillCloud())
    .then(() => pruneOrphans())
    .catch(e => console.error('[earshot] backfill error:', e));
});
