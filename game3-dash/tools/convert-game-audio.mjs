/**
 * Converts large / loose game music assets to Opus (.ogg).
 * Keeps existing .mp3 tape tracks as-is (already compressed).
 *
 * Usage: node tools/convert-game-audio.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const audioDir = path.join(projectRoot, 'public', 'audio');

/** @type {readonly { input: string; output: string; bitrate: string }[]} */
const MUSIC_TO_OGG = [
  { input: 'Background.wav', output: 'Background.ogg', bitrate: '96k' },
  { input: 'menu.mp3', output: 'menu.ogg', bitrate: '112k' },
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

for (const { input, output, bitrate } of MUSIC_TO_OGG) {
  const inputPath = path.join(audioDir, input);
  const outputPath = path.join(audioDir, output);
  if (!fs.existsSync(inputPath)) {
    console.warn(`Skip (missing): ${input}`);
    continue;
  }
  console.log(`\n→ ${input} → ${output} @ ${bitrate}`);
  runFfmpeg([
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-c:a',
    'libopus',
    '-b:a',
    bitrate,
    '-vbr',
    'on',
    '-compression_level',
    '10',
    outputPath,
  ]);
  const inKb = (fs.statSync(inputPath).size / 1024).toFixed(1);
  const outKb = (fs.statSync(outputPath).size / 1024).toFixed(1);
  const pct = ((1 - fs.statSync(outputPath).size / fs.statSync(inputPath).size) * 100).toFixed(
    0,
  );
  console.log(`  ${inKb} KB → ${outKb} KB (−${pct}%)`);
}

console.log('\nDone. Update config.ts URLs if outputs changed.');
