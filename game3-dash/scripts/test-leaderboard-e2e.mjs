/**
 * End-to-end API smoke test (no browser).
 * Run while backend is up: node scripts/test-leaderboard-e2e.mjs
 */
const API = (process.env.VITE_API_BASE_URL ?? 'http://localhost:3001').replace(
  /\/+$/,
  '',
);

async function req(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}: ${text}`);
  }
  return json;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log('[e2e] API base:', API);

  const health = await req('/health');
  assert(health.ok === true, 'health.ok');
  console.log('[e2e] health ok, db:', health.db);

  const player = await req('/api/player/create', {
    method: 'POST',
    body: JSON.stringify({ nickname: `E2E_${Date.now() % 100000}` }),
  });
  assert(player.playerId, 'playerId missing');
  console.log('[e2e] player created:', player.playerId);

  const normalScore = 12_345;
  const cheatScore = 67_890;

  const submitNormal = await req('/api/leaderboard/submit', {
    method: 'POST',
    body: JSON.stringify({
      playerId: player.playerId,
      score: normalScore,
      trackId: 'track-1',
      trackName: 'Track 1 / Stage 1',
      cheatMode: false,
    }),
  });
  assert(submitNormal.improved === true, 'normal submit should improve');
  console.log('[e2e] normal score submitted:', normalScore);

  const submitCheat = await req('/api/leaderboard/submit', {
    method: 'POST',
    body: JSON.stringify({
      playerId: player.playerId,
      score: cheatScore,
      trackId: 'track-2',
      trackName: 'Track 2 / Stage 2',
      cheatMode: true,
    }),
  });
  assert(submitCheat.improved === true, 'cheat submit should improve');
  console.log('[e2e] cheat score submitted:', cheatScore);

  const normalBoard = await req('/api/leaderboard?cheatMode=false&limit=50');
  const cheatBoard = await req('/api/leaderboard?cheatMode=true&limit=50');

  const meNormal = normalBoard.entries.find((e) => e.playerId === player.playerId);
  const meCheat = cheatBoard.entries.find((e) => e.playerId === player.playerId);

  assert(meNormal?.score === normalScore, 'normal board score mismatch');
  assert(meCheat?.score === cheatScore, 'cheat board score mismatch');
  assert(
    !normalBoard.entries.some((e) => e.cheatMode === true),
    'normal board must not list cheat rows',
  );
  assert(
    !cheatBoard.entries.some((e) => e.cheatMode === false),
    'cheat board must not list normal rows',
  );

  console.log('[e2e] normal leaderboard entries:', normalBoard.entries.length);
  console.log('[e2e] cheat leaderboard entries:', cheatBoard.entries.length);
  console.log('[e2e] all checks passed');
}

main().catch((err) => {
  console.error('[e2e] failed:', err.message ?? err);
  process.exit(1);
});
