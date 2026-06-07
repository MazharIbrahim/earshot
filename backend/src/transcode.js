// Transcodes WAV -> Opus (in Ogg container) via ffmpeg.
//
// 128 kbps stereo Opus is ~12x smaller than 16-bit 48kHz WAV and sounds
// excellent on consumer playback. Safari 14+ (incl. iOS) plays it
// natively in <audio> tags.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function resolveBinary() {
  const candidates = [
    'ffmpeg',
    path.join(os.homedir(), '.local', 'bin', 'ffmpeg'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ];
  for (const c of candidates) {
    if (c.includes('/') && fs.existsSync(c)) return c;
  }
  return 'ffmpeg';
}

const FFMPEG = resolveBinary();

export function transcodeToOpus(wavPath, opusPath, { bitrateKbps = 128 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',                            // overwrite
      '-hide_banner', '-loglevel', 'error',
      '-i', wavPath,
      '-c:a', 'libopus',
      '-b:a', `${bitrateKbps}k`,
      '-vbr', 'on',                    // variable bitrate (quality-tuned)
      '-application', 'audio',         // music-tuned signal mode
      opusPath,
    ];

    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve(opusPath);
      reject(new Error(`ffmpeg exit ${code}: ${stderr.trim()}`));
    });
  });
}
