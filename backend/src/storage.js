// Pluggable audio storage.
//
// Interface:
//   put(key, buffer | localPath, contentType)  -> writes the object
//   url(key)                                   -> URL the player should use
//   stream(key)                                -> read stream for proxying
//   exists(key)                                -> boolean
//
// Two implementations: local disk (default), and Cloudflare R2 via the
// AWS S3 SDK. Pick via EARSHOT_STORAGE env var.
//
// To switch on R2, set:
//   EARSHOT_STORAGE=r2
//   R2_ACCOUNT_ID=...
//   R2_ACCESS_KEY_ID=...
//   R2_SECRET_ACCESS_KEY=...
//   R2_BUCKET=earshot-takes
//   R2_PUBLIC_BASE=https://media.earshot.fm   (custom domain or public r2.dev)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_DIR = path.join(__dirname, '..', 'data', 'audio');
fs.mkdirSync(LOCAL_DIR, { recursive: true });

// ---------- Local disk ----------
const localStorage = {
  kind: 'local',
  async put(key, source /* path or Buffer */, _contentType) {
    const dest = path.join(LOCAL_DIR, key);
    if (Buffer.isBuffer(source)) {
      await fs.promises.writeFile(dest, source);
    } else if (source !== dest) {
      await fs.promises.copyFile(source, dest);
    }
    return dest;
  },
  // Local mode serves audio via our own /takes/:id/audio handler;
  // the URL is supplied by the API caller, not the storage layer.
  url(_key) { return null; },
  stream(key) {
    const p = path.join(LOCAL_DIR, key);
    return fs.createReadStream(p);
  },
  resolvePath(key) { return path.join(LOCAL_DIR, key); },
  exists(key) { return fs.existsSync(path.join(LOCAL_DIR, key)); },
};

// ---------- Cloudflare R2 (S3-compatible) ----------
// Activated only when EARSHOT_STORAGE=r2 to avoid pulling in the SDK
// dependency for local dev.
async function buildR2Storage() {
  const required = ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`R2 storage requested but missing env: ${missing.join(', ')}`);
  }
  const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } =
    await import('@aws-sdk/client-s3');

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  const Bucket = process.env.R2_BUCKET;
  const publicBase = (process.env.R2_PUBLIC_BASE || '').replace(/\/$/, '');

  return {
    kind: 'r2',
    async put(key, source, contentType) {
      const Body = Buffer.isBuffer(source) ? source : fs.createReadStream(source);
      await client.send(new PutObjectCommand({
        Bucket, Key: key, Body, ContentType: contentType,
      }));
    },
    url(key) {
      // Public custom-domain URL. R2 free egress means we can serve direct
      // from R2 instead of proxying through this server.
      return publicBase ? `${publicBase}/${key}` : null;
    },
    stream(key) {
      // Returns an async iterable; used as a fallback when no public URL.
      return client.send(new GetObjectCommand({ Bucket, Key: key }))
        .then(r => r.Body);
    },
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket, Key: key }));
        return true;
      } catch { return false; }
    },
  };
}

// ---------- Supabase Storage ----------
async function buildSupabaseStorage() {
  const required = ['SUPABASE_URL','SUPABASE_SERVICE_KEY','SUPABASE_BUCKET'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`supabase storage requested but missing env: ${missing.join(', ')}`);
  }
  const { StorageClient } = await import('@supabase/storage-js');
  // storage-js is a focused subpackage of supabase-js; avoids pulling in
  // the realtime client which requires `ws` on Node < 22.
  const client = new StorageClient(
    `${process.env.SUPABASE_URL}/storage/v1`,
    {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    }
  );
  const Bucket = process.env.SUPABASE_BUCKET;
  const publicBase = `${process.env.SUPABASE_URL}/storage/v1/object/public/${Bucket}`;

  return {
    kind: 'supabase',
    async put(key, source, contentType) {
      const Body = Buffer.isBuffer(source) ? source : await fs.promises.readFile(source);
      const { error } = await client.from(Bucket).upload(key, Body, {
        contentType,
        upsert: true,
        cacheControl: '31536000', // immutable; key is unique per upload
      });
      if (error) throw new Error(`supabase upload failed: ${error.message}`);
    },
    url(key) {
      // Public bucket — direct CDN URL, no proxy through us.
      return `${publicBase}/${key}`;
    },
    async stream(key) {
      const { data, error } = await client.from(Bucket).download(key);
      if (error) throw new Error(`supabase download failed: ${error.message}`);
      return data;
    },
    async exists(key) {
      try {
        const { data } = await client.from(Bucket).list('', { search: key, limit: 1 });
        return Array.isArray(data) && data.some(f => f.name === key);
      } catch { return false; }
    },
  };
}

let cached;
export async function getStorage() {
  if (cached) return cached;
  const kind = (process.env.EARSHOT_STORAGE || 'local').toLowerCase();
  if (kind === 'r2')       cached = await buildR2Storage();
  else if (kind === 'supabase') cached = await buildSupabaseStorage();
  else                     cached = localStorage;
  console.log(`[earshot] storage backend: ${cached.kind}`);
  return cached;
}
