import { expect, test } from '@playwright/test';

const PLAYER_KEY = 'game3-dash-player-v1';
const HIGH_SCORE_KEY = 'game3-dash-high-scores-v3';
const TEST_NICK = `PW_${Date.now() % 100_000}`;

test.describe('local leaderboard UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('game3-dash-player-v1');
      localStorage.removeItem('game3-dash-high-scores-v3');
    });
  });

  test('nickname, score submit, and global leaderboard tabs', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(err.message);
    });

    await page.goto('/');

    await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 90_000 });
    await expect(page.locator('#main-menu-play')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#nickname-modal')).toBeVisible();

    await page.fill('#nickname-modal-input', TEST_NICK);
    await page.locator('#nickname-modal-ok').click();
    await expect(page.locator('#nickname-modal')).toBeHidden();
    await page.waitForFunction(
      (key) => {
        try {
          const raw = localStorage.getItem(key);
          if (!raw) return false;
          const parsed = JSON.parse(raw) as { playerId?: string };
          return Boolean(parsed.playerId);
        } catch {
          return false;
        }
      },
      PLAYER_KEY,
      { timeout: 20_000 },
    );

    const stored = await page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    }, PLAYER_KEY);

    expect(stored?.playerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(stored?.nickname).toBe(TEST_NICK);

    const normalResult = await page.evaluate(async () => {
      const dev = window.__gameDev;
      if (!dev) throw new Error('window.__gameDev missing (not in DEV mode?)');
      return dev.submitTestScore({
        cheatMode: false,
        score: 2500,
        trackId: 'track-1',
        trackName: 'Track 1 / Stage 1',
      });
    });
    expect(normalResult.improved).toBe(true);
    expect(normalResult.player?.playerId).toBe(stored.playerId);

    const cheatResult = await page.evaluate(async () => {
      const dev = window.__gameDev!;
      return dev.submitTestScore({
        cheatMode: true,
        score: 9900,
        trackId: 'track-2',
        trackName: 'Track 2 / Stage 2',
      });
    });
    expect(cheatResult.improved).toBe(true);

    await page.click('#main-menu-highscore');
    await expect(page.locator('#highscore-menu-panel')).toBeVisible();
    await expect(page.locator('#global-leaderboard-panel')).toBeVisible();

    const normalList = page.locator('#global-leaderboard-list');
    const normalRow = normalList.locator('.global-leaderboard__row', {
      hasText: TEST_NICK,
    });
    await expect(normalRow).toHaveCount(1);
    await expect(normalRow.locator('.global-leaderboard__score')).toHaveText('2500');

    await page.locator('.global-leaderboard__tab[data-cheat-mode="true"]').click();
    const cheatRow = normalList.locator('.global-leaderboard__row', {
      hasText: TEST_NICK,
    });
    await expect(cheatRow).toHaveCount(1);
    await expect(cheatRow.locator('.global-leaderboard__score')).toHaveText('9900');
    await expect(cheatRow.locator('.global-leaderboard__cheat-badge')).toHaveCount(1);
    await expect(normalList.locator('.global-leaderboard__row', { hasText: '2500' })).toHaveCount(0);

    const criticalErrors = consoleErrors.filter(
      (line) =>
        !line.includes('favicon') &&
        !line.includes('Failed to load resource') &&
        !line.includes('WebGL') &&
        !line.includes('THREE.'),
    );
    expect(criticalErrors).toEqual([]);
  });

  test('dev panel buttons submit and open BEST SCORE', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#loading-screen')).toBeHidden({ timeout: 90_000 });
    await expect(page.locator('#main-menu-play')).toBeVisible({ timeout: 30_000 });

    await page.fill('#nickname-modal-input', `Dev_${TEST_NICK}`);
    await page.locator('#nickname-modal-ok').click();
    await expect(page.locator('#nickname-modal')).toBeHidden();
    await page.waitForFunction(
      (key) => Boolean(localStorage.getItem(key)),
      PLAYER_KEY,
      { timeout: 20_000 },
    );

    await expect(page.locator('#leaderboard-dev-tools')).toBeVisible();
    await page.locator('#leaderboard-dev-tools [data-action="normal"]').click();
    await page.locator('#leaderboard-dev-tools [data-action="cheat"]').click();
    await page.locator('#leaderboard-dev-tools [data-action="best"]').click();

    await expect(page.locator('#global-leaderboard-list')).toContainText(
      `Dev_${TEST_NICK}`,
    );
  });
});
