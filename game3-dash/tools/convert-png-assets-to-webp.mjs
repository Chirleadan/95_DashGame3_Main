/**
 * Backs up game-used PNGs and converts them to WebP (quality-first).
 * Requires: npm install (ffmpeg-static).
 *
 * Usage: node tools/convert-png-assets-to-webp.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const publicAssets = path.join(projectRoot, 'public', 'assets');
const backupRoot = path.join(projectRoot, 'tools', 'asset-backup', 'png');

/** PNG paths under `public/assets/` referenced by game code (not menu-noise fallbacks). */
const GAME_PNG_REL_PATHS = [
  'back 1.png',
  'player/player_idle_1.png',
  'player/player_dash_1.png',
  'player/player_step_1.png',
  'player/player_step_2.png',
  'player/player_step_3.png',
  'player/player_step_4.png',
  'enemies/normal/idle.png',
  'enemies/normal/mob_death.png',
  'enemies/shooter/idle.png',
  'enemies/shooter/shooter_death.png',
  'enemies/tank/idle.png',
  'enemies/tank/tank_death.png',
  'enemies/angel/idle.png',
  'enemies/angel/angel_death.png',
  'enemies/vault/vault_1.png',
  'lvlup/Dash Range.png',
  'lvlup/Character  Speed.png',
  'lvlup/Shields.png',
  'lvlup/Shield Regen.png',
  'lvlup/Enemy Slow.png',
  'lvlup/Rockets.png',
  'lvlup/Artifact  Lightning.png',
  'lvlup/Claw-Dash.png',
  'lvlup/Projectile Shields.png',
  'lvlup/Phase Dash.png',
  'lvlup/spiral.png',
  'tapes/1.PNG',
  'tapes/2.PNG',
  'tapes/3.PNG',
];

const LARGE_ASSET_BYTES = 120_000;
const QUALITY_SPRITE = 90;
const QUALITY_LARGE = 85;

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

function webpNameFromPng(pngName) {
  return pngName.replace(/\.(png|PNG)$/i, '.webp');
}

function ensureBackup(srcAbs, relPath) {
  const dest = path.join(backupRoot, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(srcAbs, dest);
    return { copied: true };
  }
  return { copied: false };
}

const report = [];

for (const rel of GAME_PNG_REL_PATHS) {
  const input = path.join(publicAssets, rel);
  if (!fs.existsSync(input)) {
    console.error(`Missing: ${rel}`);
    process.exit(1);
  }

  const pngBytes = fs.statSync(input).size;
  const quality = pngBytes >= LARGE_ASSET_BYTES ? QUALITY_LARGE : QUALITY_SPRITE;
  const webpFile = webpNameFromPng(path.basename(rel));
  const webpRel = path.join(path.dirname(rel), webpFile).replace(/\\/g, '/');
  const output = path.join(publicAssets, webpRel);

  ensureBackup(input, rel);

  console.log(`\n→ ${rel} → ${webpRel} (q=${quality})`);
  runFfmpeg([
    '-y',
    '-i',
    input,
    '-c:v',
    'libwebp',
    '-lossless',
    '0',
    '-quality',
    String(quality),
    '-preset',
    'default',
    output,
  ]);

  const webpBytes = fs.statSync(output).size;
  const pct = ((1 - webpBytes / pngBytes) * 100).toFixed(1);
  report.push({ rel, webpRel, pngBytes, webpBytes, quality, savedPct: pct });

  fs.unlinkSync(input);
  console.log(`  removed public PNG; backup at tools/asset-backup/png/${rel}`);
}

const totalPng = report.reduce((s, r) => s + r.pngBytes, 0);
const totalWebp = report.reduce((s, r) => s + r.webpBytes, 0);
console.log('\n=== Summary ===');
for (const row of report) {
  console.log(
    `  ${row.rel}: ${(row.pngBytes / 1024).toFixed(1)} KB → ${(row.webpBytes / 1024).toFixed(1)} KB (−${row.savedPct}%)`,
  );
}
console.log(
  `  TOTAL: ${(totalPng / 1024 / 1024).toFixed(2)} MB → ${(totalWebp / 1024 / 1024).toFixed(2)} MB (−${((1 - totalWebp / totalPng) * 100).toFixed(1)}%)`,
);
console.log(`\nBackups: ${path.relative(projectRoot, backupRoot)}`);
