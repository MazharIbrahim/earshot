// DB adapter — same surface for SQLite (default, laptop-only) and Supabase
// Postgres (opt-in via EARSHOT_DB=supabase, works when laptop is off).
//
// Both backends speak the same camelCase API to the rest of the server,
// so flipping the flag is a one-line change and no SQL needs to be
// scattered through server.js.

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(__dirname, '..', 'data');

// ---------- SQLite ----------
function buildSqlite() {
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
  for (const sql of [
    'ALTER TABLE takes ADD COLUMN opus_filename TEXT',
    'ALTER TABLE takes ADD COLUMN note TEXT',
    'ALTER TABLE takes ADD COLUMN idempotency_key TEXT',
  ]) { try { db.exec(sql); } catch {} }
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_takes_idem ON takes (idempotency_key) WHERE idempotency_key IS NOT NULL');
  } catch {}

  const projectRowToApi = (r) => ({
    projectId: r.projectId,
    project:   r.project,
    takes:     r.takes,
    latestCreatedAt: r.latestCreatedAt,
  });

  return {
    kind: 'sqlite',
    insertTake(t) {
      db.prepare(`
        INSERT INTO takes (id, project, project_id, filename, opus_filename,
                           duration_sec, bytes, created_at, note, idempotency_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(t.id, t.project, t.projectId, t.filename, t.opusFilename ?? null,
             t.durationSec, t.bytes, t.createdAt, t.note ?? null, t.idempotencyKey ?? null);
      return t;
    },

    findByIdempotency(key) {
      if (!key) return null;
      const row = db.prepare(`
        SELECT id, project, project_id AS projectId,
               duration_sec AS durationSec, bytes, created_at AS createdAt,
               opus_filename AS opusFilename
        FROM takes WHERE idempotency_key = ?
      `).get(key);
      return row || null;
    },

    listProjects() {
      const rows = db.prepare(`
        SELECT project_id AS projectId, project,
               COUNT(*) AS takes, MAX(created_at) AS latestCreatedAt
        FROM takes
        GROUP BY project_id, project
        ORDER BY latestCreatedAt DESC
      `).all();
      return rows.map(projectRowToApi);
    },

    listTakes(projectId) {
      return db.prepare(`
        SELECT id, project, project_id AS projectId,
               duration_sec AS durationSec, bytes, note,
               created_at AS createdAt
        FROM takes WHERE project_id = ?
        ORDER BY created_at DESC
      `).all(projectId);
    },

    getTakeFiles(id) {
      const row = db.prepare(
        'SELECT filename, opus_filename AS opusFilename FROM takes WHERE id = ?'
      ).get(id);
      return row || null;
    },

    updateNote(id, note) {
      const res = db.prepare('UPDATE takes SET note = ? WHERE id = ?').run(note, id);
      return res.changes > 0;
    },

    deleteTake(id) {
      const res = db.prepare('DELETE FROM takes WHERE id = ?').run(id);
      return res.changes > 0;
    },

    allTakes() {
      return db.prepare(
        'SELECT id, filename, opus_filename AS opusFilename FROM takes'
      ).all();
    },

    setOpusFilename(id, opusFilename) {
      db.prepare('UPDATE takes SET opus_filename = ? WHERE id = ?').run(opusFilename, id);
    },
  };
}

// ---------- Supabase Postgres (via PostgREST + fetch) ----------
function buildSupabase() {
  const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL || !KEY) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY required for EARSHOT_DB=supabase');

  const REST = `${URL}/rest/v1`;
  const baseHeaders = {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    'Content-Type': 'application/json',
  };

  async function pg(method, path, { body, headers = {} } = {}) {
    const r = await fetch(REST + path, {
      method,
      headers: { ...baseHeaders, ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`postgrest ${method} ${path} → ${r.status}: ${text}`);
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  // Maps SQL columns ↔ camelCase fields.
  const toApi = (r) => ({
    id: r.id,
    project: r.project,
    projectId: r.project_id,
    filename: r.filename,
    opusFilename: r.opus_filename ?? null,
    durationSec: r.duration_sec,
    bytes: r.bytes,
    note: r.note ?? null,
    createdAt: r.created_at,
  });
  const toRow = (t) => ({
    id: t.id,
    project: t.project,
    project_id: t.projectId,
    filename: t.filename,
    opus_filename: t.opusFilename ?? null,
    duration_sec: t.durationSec,
    bytes: t.bytes,
    note: t.note ?? null,
    created_at: t.createdAt,
    idempotency_key: t.idempotencyKey ?? null,
  });

  return {
    kind: 'supabase',
    async insertTake(t) {
      const inserted = await pg('POST', '/takes', {
        body: toRow(t),
        headers: { Prefer: 'return=representation' },
      });
      return inserted?.[0] ? toApi(inserted[0]) : t;
    },

    async findByIdempotency(key) {
      if (!key) return null;
      const rows = await pg('GET',
        `/takes?select=id,project,project_id,filename,opus_filename,duration_sec,bytes,created_at` +
        `&idempotency_key=eq.${encodeURIComponent(key)}&limit=1`);
      return rows?.[0] ? toApi(rows[0]) : null;
    },

    async listProjects() {
      // PostgREST has no GROUP BY in the basic API; fetch and aggregate.
      // Volume is small (hundreds of rows), so this is fine in v1.
      const rows = await pg('GET',
        '/takes?select=project_id,project,created_at&order=created_at.desc');
      const byId = new Map();
      for (const r of rows || []) {
        const existing = byId.get(r.project_id);
        if (existing) {
          existing.takes++;
          if (r.created_at > existing.latestCreatedAt) existing.latestCreatedAt = r.created_at;
        } else {
          byId.set(r.project_id, {
            projectId: r.project_id,
            project: r.project,
            takes: 1,
            latestCreatedAt: r.created_at,
          });
        }
      }
      return Array.from(byId.values())
        .sort((a, b) => b.latestCreatedAt - a.latestCreatedAt);
    },

    async listTakes(projectId) {
      const rows = await pg('GET',
        `/takes?select=id,project,project_id,duration_sec,bytes,note,created_at` +
        `&project_id=eq.${encodeURIComponent(projectId)}&order=created_at.desc`);
      return (rows || []).map(toApi);
    },

    async getTakeFiles(id) {
      const rows = await pg('GET',
        `/takes?select=filename,opus_filename&id=eq.${encodeURIComponent(id)}&limit=1`);
      if (!rows?.[0]) return null;
      return { filename: rows[0].filename, opusFilename: rows[0].opus_filename ?? null };
    },

    async updateNote(id, note) {
      const rows = await pg('PATCH',
        `/takes?id=eq.${encodeURIComponent(id)}`,
        { body: { note }, headers: { Prefer: 'return=representation' } });
      return !!(rows && rows.length);
    },

    async deleteTake(id) {
      const rows = await pg('DELETE',
        `/takes?id=eq.${encodeURIComponent(id)}`,
        { headers: { Prefer: 'return=representation' } });
      return !!(rows && rows.length);
    },

    async allTakes() {
      const rows = await pg('GET', '/takes?select=id,filename,opus_filename');
      return (rows || []).map(r => ({
        id: r.id, filename: r.filename, opusFilename: r.opus_filename ?? null,
      }));
    },

    async setOpusFilename(id, opusFilename) {
      await pg('PATCH', `/takes?id=eq.${encodeURIComponent(id)}`,
        { body: { opus_filename: opusFilename } });
    },
  };
}

let cached;
export async function openDb() {
  if (cached) return cached;
  const kind = (process.env.EARSHOT_DB || 'sqlite').toLowerCase();
  cached = kind === 'supabase' ? buildSupabase() : buildSqlite();
  console.log(`[earshot] db backend: ${cached.kind}`);
  return cached;
}
