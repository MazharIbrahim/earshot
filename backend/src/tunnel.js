// Spawns a Cloudflare quick tunnel pointing at our local server and
// extracts the public *.trycloudflare.com URL from its output.
//
// Disabled when EARSHOT_TUNNEL=off. Falls back gracefully if the
// cloudflared binary isn't on PATH.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const PUBLIC_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

function resolveBinary() {
  const candidates = [
    'cloudflared',
    path.join(os.homedir(), '.local', 'bin', 'cloudflared'),
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
  ];
  for (const c of candidates) {
    if (c.includes('/') ? fs.existsSync(c) : true) return c;
  }
  return 'cloudflared';
}

export function startTunnel({ port, onUrl }) {
  if ((process.env.EARSHOT_TUNNEL || '').toLowerCase() === 'off') {
    console.log('[earshot] tunnel disabled via EARSHOT_TUNNEL=off');
    return { state: 'disabled', publicUrl: null };
  }

  const status = { state: 'starting', publicUrl: null, error: null };
  const bin = resolveBinary();

  let child;
  try {
    child = spawn(bin, [
      'tunnel',
      '--url', `http://localhost:${port}`,
      '--no-autoupdate',
      '--logfile', '/dev/stderr',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    status.state = 'failed';
    status.error = `cloudflared spawn failed: ${e.message}`;
    console.error('[earshot]', status.error);
    return status;
  }

  const onData = (buf) => {
    const text = buf.toString();
    const match = text.match(PUBLIC_URL_RE);
    if (match && !status.publicUrl) {
      status.publicUrl = match[0];
      status.state = 'running';
      console.log(`[earshot] public URL ready: ${status.publicUrl}`);
      if (onUrl) onUrl(status.publicUrl);
    }
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('exit', (code) => {
    status.state = 'stopped';
    console.log(`[earshot] cloudflared exited with code ${code}`);
  });

  child.on('error', (err) => {
    status.state = 'failed';
    status.error = err.message;
    console.error('[earshot] cloudflared error:', err.message);
  });

  return status;
}
