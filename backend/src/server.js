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
      partSize: 8 * 1024 * 1024,
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
  res.json(await db.listProjects(req.userId));
});

app.get('/projects/:id/takes', requireAuth, async (req, res) => {
  res.json(await db.listTakes(req.params.id, req.userId));
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
