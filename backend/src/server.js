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

  // Transcode synchronously: small files transcode in under a second
  // and we want the client to know the take is fully ready.
  let opusFilename = null;
  try {
    await transcodeToOpus(wavPath, opusPath, { bitrateKbps: 128 });
    opusFilename = opusName;
    console.log(`[earshot] transcoded ${req.file.filename} -> ${opusName}`
      + ` (${(fs.statSync(opusPath).size / 1024).toFixed(1)} KB`
      + ` vs ${(req.file.size / 1024).toFixed(1)} KB WAV)`);
  } catch (e) {
    console.error('[earshot] transcode failed:', e.message);
    // Continue without Opus — clients fall back to WAV.
  }

  // Push to remote storage when configured. Local backend is a no-op
  // (multer already wrote the WAV; ffmpeg already wrote the Opus).
  // We only push the Opus by default — that's all mobile playback ever
  // needs, and it's ~10x smaller than the WAV, which is the single
  // biggest factor in upload time. The WAV stays on the laptop's local
  // disk; set EARSHOT_UPLOAD_WAV=true if/when you wire up a
  // "download original" feature that needs WAV in R2.
  const uploadWav = (process.env.EARSHOT_UPLOAD_WAV || 'false').toLowerCase() === 'true';
  try {
    const storage = await getStorage();
    if (storage.kind !== 'local') {
      if (opusFilename) await storage.put(opusFilename, opusPath, 'audio/ogg');
      if (uploadWav)    await storage.put(req.file.filename, wavPath, 'audio/wav');
    }
  } catch (e) {
    console.error('[earshot] storage put failed:', e.message);
    return res.status(502).json({ error: 'storage upload failed', detail: e.message });
  }

  const now = Date.now();
  await db.insertTake({
    id, project, projectId,
    filename: req.file.filename,
    opusFilename,
    durationSec: duration,
    bytes: req.file.size,
    createdAt: now,
    idempotencyKey: idemKey,
  }, req.userId);

  res.json({
    id, project, projectId,
    durationSec: duration,
    bytes: req.file.size,
    opus: opusFilename != null,
    createdAt: now,
  });
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
