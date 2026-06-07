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

import express from 'express';
import multer from 'multer';
import cors from 'cors';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startTunnel } from './tunnel.js';
import { transcodeToOpus } from './transcode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, '..', 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
fs.mkdirSync(AUDIO_DIR, { recursive: true });

// ---------- DB ----------
const db = new Database(path.join(DATA_DIR, 'earshot.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS takes (
    id           TEXT PRIMARY KEY,
    project      TEXT NOT NULL,
    project_id   TEXT NOT NULL,
    filename     TEXT NOT NULL,
    duration_sec REAL NOT NULL,
    bytes        INTEGER NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_takes_project ON takes (project_id, created_at DESC);
`);

// Best-effort migration: add opus_filename column on existing DBs.
try { db.exec('ALTER TABLE takes ADD COLUMN opus_filename TEXT'); }
catch (e) { /* already exists, ignore */ }

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

// POST /takes — multipart: file=audio, fields: project, durationSec
app.post('/takes', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required' });

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

  db.prepare(`
    INSERT INTO takes (id, project, project_id, filename, opus_filename,
                       duration_sec, bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, project, projectId, req.file.filename, opusFilename,
         duration, req.file.size, Date.now());

  res.json({
    id,
    project,
    projectId,
    durationSec: duration,
    bytes: req.file.size,
    opus: opusFilename != null,
    createdAt: Date.now(),
  });
});

app.get('/projects', (_req, res) => {
  const rows = db.prepare(`
    SELECT project_id AS projectId,
           project,
           COUNT(*) AS takes,
           MAX(created_at) AS latestCreatedAt
    FROM takes
    GROUP BY project_id, project
    ORDER BY latestCreatedAt DESC
  `).all();
  res.json(rows);
});

app.get('/projects/:id/takes', (req, res) => {
  const rows = db.prepare(`
    SELECT id, project, project_id AS projectId,
           duration_sec AS durationSec,
           bytes,
           created_at AS createdAt
    FROM takes
    WHERE project_id = ?
    ORDER BY created_at DESC
  `).all(req.params.id);
  res.json(rows);
});

// GET /takes/:id/audio
// Default: Opus (12x smaller, near-instant start on mobile).
// ?format=wav: original lossless WAV (for archival download, Pro feature).
app.get('/takes/:id/audio', (req, res) => {
  const row = db.prepare(
    'SELECT filename, opus_filename FROM takes WHERE id = ?'
  ).get(req.params.id);
  if (!row) return res.status(404).end();

  const wantWav = req.query.format === 'wav';
  const serveOpus = !wantWav && row.opus_filename;

  const filename = serveOpus ? row.opus_filename : row.filename;
  const filePath = path.join(AUDIO_DIR, filename);
  if (!fs.existsSync(filePath)) {
    // Opus missing but WAV exists — fall back gracefully.
    if (serveOpus) {
      const wavFallback = path.join(AUDIO_DIR, row.filename);
      if (fs.existsSync(wavFallback)) {
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Accept-Ranges', 'bytes');
        return res.sendFile(wavFallback);
      }
    }
    return res.status(404).end();
  }

  res.setHeader('Content-Type', serveOpus ? 'audio/ogg' : 'audio/wav');
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(filePath);
});

// SPA fallback: anything that wasn't an API route or a static file gets
// the PWA's index.html so React Router handles client-side routing.
app.get(/^\/(?!projects|takes|healthz).*/, (_req, res, next) => {
  const indexFile = path.join(WEB_DIST, 'index.html');
  if (fs.existsSync(indexFile)) return res.sendFile(indexFile);
  next();
});

// Background backfill: takes uploaded before transcoding was added get a
// .opus next to their .wav. Runs sequentially with low priority so we
// don't fight live uploads.
async function backfillOpus() {
  const rows = db.prepare(
    'SELECT id, filename FROM takes WHERE opus_filename IS NULL'
  ).all();
  if (rows.length === 0) return;
  console.log(`[earshot] backfill: ${rows.length} take(s) need transcoding`);

  for (const row of rows) {
    const wavPath = path.join(AUDIO_DIR, row.filename);
    if (!fs.existsSync(wavPath)) continue;
    const opusName = row.filename.replace(/\.[^.]+$/, '') + '.opus';
    const opusPath = path.join(AUDIO_DIR, opusName);
    try {
      await transcodeToOpus(wavPath, opusPath, { bitrateKbps: 128 });
      db.prepare('UPDATE takes SET opus_filename = ? WHERE id = ?')
        .run(opusName, row.id);
      console.log(`[earshot] backfilled ${row.filename}`);
    } catch (e) {
      console.error(`[earshot] backfill failed for ${row.filename}:`, e.message);
    }
  }
}

const PORT = process.env.PORT || 8787;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[earshot] backend listening on http://localhost:${PORT}`);
  tunnelStatus = startTunnel({
    port: PORT,
    onUrl: (url) => { tunnelStatus.publicUrl = url; tunnelStatus.state = 'running'; },
  });
  // Fire-and-forget; logs progress.
  backfillOpus().catch(e => console.error('[earshot] backfill error:', e));
});
