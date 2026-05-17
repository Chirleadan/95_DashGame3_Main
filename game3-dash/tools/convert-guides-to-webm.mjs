/**
 * Converts public/assets/guides/*.gif to matching .webm (VP9 + alpha via yuva420p).
 * Requires: npm install (ffmpeg-static is a devDependency).
 *
 * Usage: node tools/convert-guides-to-webm.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const guidesDir = path.join(projectRoot, 'public', 'assets', 'guides');

/** @type {readonly { gif: string; webm: string }[]} */
const MAP = [
  { gif: 'damage.gif', webm: 'damage.webm' },
  { gif: 'enemies.gif', webm: 'enemies.webm' },
  { gif: 'Tape Mode.gif', webm: 'tape-mode.webm' },
  { gif: 'vault.gif', webm: 'vault.webm' },
  { gif: 'Dash Combat.gif', webm: 'dash-combat.webm' },
];

if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  console.error('ffmpeg-static binary not found. Run: npm install');
  process.exit(1);
}

function runFfmpeg(args) {
  const result = spawnSync(ffmpegPath, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

for (const { gif, webm } of MAP) {
  const input = path.join(guidesDir, gif);
  const output = path.join(guidesDir, webm);
  if (!fs.existsSync(input)) {
    console.error(`Missing input: ${input}`);
    process.exit(1);
  }
  console.log(`\n→ ${gif} → ${webm}`);
  runFfmpeg([
    '-y',
    '-i',
    input,
    '-an',
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-b:v',
    '0',
    '-crf',
    '32',
    '-row-mt',
    '1',
    '-auto-alt-ref',
    '0',
    '-loop',
    '1',
    output,
  ]);
  const inKb = (fs.statSync(input).size / 1024).toFixed(1);
  const outKb = (fs.statSync(output).size / 1024).toFixed(1);
  const pct = ((1 - fs.statSync(output).size / fs.statSync(input).size) * 100).toFixed(0);
  console.log(`  ${inKb} KB → ${outKb} KB (−${pct}%)`);
}

console.log('\nDone. Original GIFs kept as fallback.');
