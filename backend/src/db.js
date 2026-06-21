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
    'ALTER TABLE takes ADD COLUMN user_id TEXT',
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

  // userId is opt-in for SQLite: in single-user dev mode we don't track
  // ownership. Pass it through to keep API parity with the Supabase impl;
  // SQLite simply ignores it.
  return {
    kind: 'sqlite',
    insertTake(t, _userId) {
      db.prepare(`
        INSERT INTO takes (id, project, project_id, filename, opus_filename,
                           duration_sec, bytes, created_at, note, idempotency_key, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(t.id, t.project, t.projectId, t.filename, t.opusFilename ?? null,
             t.durationSec, t.bytes, t.createdAt, t.note ?? null,
             t.idempotencyKey ?? null, _userId ?? null);
      return t;
    },

    findByIdempotency(key, userId) {
      if (!key) return null;
      const row = db.prepare(`
        SELECT id, project, project_id AS projectId,
               duration_sec AS durationSec, bytes, created_at AS createdAt,
               opus_filename AS opusFilename
        FROM takes WHERE idempotency_key = ? AND (user_id = ? OR user_id IS NULL)
      `).get(key, userId ?? null);
      return row || null;
    },

    listProjects(userId) {
      const rows = db.prepare(`
        SELECT project_id AS projectId, project,
               COUNT(*) AS takes, MAX(created_at) AS latestCreatedAt
        FROM takes WHERE user_id = ? OR user_id IS NULL
        GROUP BY project_id, project
        ORDER BY latestCreatedAt DESC
      `).all(userId ?? null);
      return rows.map(projectRowToApi);
    },

    listTakes(projectId, userId) {
      return db.prepare(`
        SELECT id, project, project_id AS projectId,
               duration_sec AS durationSec, bytes, note,
               created_at AS createdAt
        FROM takes WHERE project_id = ? AND (user_id = ? OR user_id IS NULL)
        ORDER BY created_at DESC
      `).all(projectId, userId ?? null);
    },

    // No userId on getTakeFiles — used by the audio endpoint which is
    // intentionally public (share links). Authorization happens in the
    // handler if we ever need it.
    getTakeFiles(id) {
      const row = db.prepare(
        'SELECT filename, opus_filename AS opusFilename, user_id AS userId FROM takes WHERE id = ?'
      ).get(id);
      return row || null;
    },

    updateNote(id, note, userId) {
      const res = db.prepare(
        'UPDATE takes SET note = ? WHERE id = ? AND (user_id = ? OR user_id IS NULL)'
      ).run(note, id, userId ?? null);
      return res.changes > 0;
    },

    deleteTake(id, userId) {
      const res = db.prepare(
        'DELETE FROM takes WHERE id = ? AND (user_id = ? OR user_id IS NULL)'
      ).run(id, userId ?? null);
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
  const toRow = (t, userId) => ({
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
    user_id: userId ?? null,
  });

  // PostgREST filter for "owned by this user or unowned (pre-auth data)".
  // Unowned rows exist from before the user_id column was added; this lets
  // them remain visible to the developer's account until we backfill.
  const ownerFilter = (userId) =>
    userId
      ? `or=(user_id.eq.${encodeURIComponent(userId)},user_id.is.null)`
      : 'user_id=is.null';

  return {
    kind: 'supabase',
    async insertTake(t, userId) {
      const inserted = await pg('POST', '/takes', {
        body: toRow(t, userId),
        headers: { Prefer: 'return=representation' },
      });
      return inserted?.[0] ? toApi(inserted[0]) : t;
    },

    async findByIdempotency(key, userId) {
      if (!key) return null;
      const rows = await pg('GET',
        `/takes?select=id,project,project_id,filename,opus_filename,duration_sec,bytes,created_at` +
        `&idempotency_key=eq.${encodeURIComponent(key)}&${ownerFilter(userId)}&limit=1`);
      return rows?.[0] ? toApi(rows[0]) : null;
    },

    async listProjects(userId) {
      const rows = await pg('GET',
        `/takes?select=project_id,project,created_at&${ownerFilter(userId)}&order=created_at.desc`);
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

    async listTakes(projectId, userId) {
      const rows = await pg('GET',
        `/takes?select=id,project,project_id,duration_sec,bytes,note,created_at` +
        `&project_id=eq.${encodeURIComponent(projectId)}` +
        `&${ownerFilter(userId)}&order=created_at.desc`);
      return (rows || []).map(toApi);
    },

    // Audio endpoint stays public for share links — no userId filter here.
    // The handler decides whether to enforce ownership.
    async getTakeFiles(id) {
      const rows = await pg('GET',
        `/takes?select=filename,opus_filename,user_id&id=eq.${encodeURIComponent(id)}&limit=1`);
      if (!rows?.[0]) return null;
      return {
        filename: rows[0].filename,
        opusFilename: rows[0].opus_filename ?? null,
        userId: rows[0].user_id ?? null,
      };
    },

    async updateNote(id, note, userId) {
      const rows = await pg('PATCH',
        `/takes?id=eq.${encodeURIComponent(id)}&${ownerFilter(userId)}`,
        { body: { note }, headers: { Prefer: 'return=representation' } });
      return !!(rows && rows.length);
    },

    async deleteTake(id, userId) {
      const rows = await pg('DELETE',
        `/takes?id=eq.${encodeURIComponent(id)}&${ownerFilter(userId)}`,
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
