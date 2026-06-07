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

const slug = (s) => (s || 'untitled')
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '') || 'untitled';

// ---------- App ----------
const app = express();
app.use(cors());
app.use(express.json());

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

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// POST /takes — multipart: file=audio, fields: project, durationSec
app.post('/takes', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required' });

  const project = (req.body.project || 'Untitled').toString().slice(0, 200);
  const projectId = slug(project);
  const duration = Number(req.body.durationSec) || 0;
  const id = nanoid();

  db.prepare(`
    INSERT INTO takes (id, project, project_id, filename, duration_sec, bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, project, projectId, req.file.filename, duration, req.file.size, Date.now());

  res.json({
    id,
    project,
    projectId,
    durationSec: duration,
    bytes: req.file.size,
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

app.get('/takes/:id/audio', (req, res) => {
  const row = db.prepare('SELECT filename FROM takes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).end();
  const filePath = path.join(AUDIO_DIR, row.filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();

  // express handles Range requests when using sendFile.
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(filePath);
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[earshot] backend listening on http://localhost:${PORT}`);
});
