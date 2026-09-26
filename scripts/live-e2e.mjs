#!/usr/bin/env node

/**
 * Run one complete game against an explicitly selected deployment.
 *
 * This is deliberately outside the Playwright test suite: it creates a real
 * room and is therefore opt-in. Every interaction goes through the visible
 * UI so the host and each player exercise the same path as a human device.
 *
 * Example:
 *   MAFIA_LIVE_BASE_URL=https://mafia.example.com node scripts/live-e2e.mjs
 *
 * Useful observation switches:
 *   MAFIA_LIVE_HEADLESS=false   Show the browser windows.
 *   MAFIA_LIVE_SLOW_MO_MS=150   Slow Playwright actions for a walkthrough.
 *   MAFIA_LIVE_TIMEOUT_MS=60000 Increase phase/action wait time.
 *   MAFIA_LIVE_ARTIFACT_DIR=/tmp/mafia-live-failure Save failure diagnostics there.
 */

import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin'];
const defaultTimeoutMs = 30_000;

function parsePositiveInt(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseNonNegativeInt(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (/^(false|0|no)$/i.test(value)) return false;
  if (/^(true|1|yes)$/i.test(value)) return true;
  throw new Error(`MAFIA_LIVE_HEADLESS must be true or false, received ${JSON.stringify(value)}`);
}

function normalizeBaseUrl(value) {
  if (!value?.trim()) {
    throw new Error(
      'MAFIA_LIVE_BASE_URL is required. Set it explicitly, for example: ' +
        'MAFIA_LIVE_BASE_URL=https://mafia.example.com node scripts/live-e2e.mjs',
    );
  }
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`MAFIA_LIVE_BASE_URL must use http or https, received ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('MAFIA_LIVE_BASE_URL must not contain embedded credentials');
  }
  return url.toString().replace(/\/+$/, '');
}

const base = normalizeBaseUrl(process.env.MAFIA_LIVE_BASE_URL);
const timeoutMs = parsePositiveInt(process.env.MAFIA_LIVE_TIMEOUT_MS, defaultTimeoutMs, 'MAFIA_LIVE_TIMEOUT_MS');
const headless = parseBoolean(process.env.MAFIA_LIVE_HEADLESS, true);
const slowMo = parseNonNegativeInt(process.env.MAFIA_LIVE_SLOW_MO_MS, 0, 'MAFIA_LIVE_SLOW_MO_MS');

const browser = await chromium.launch({ headless, slowMo });
const contexts = [];
const sessions = [];
const frames = new Map();
const diagnostics = new Map();
const elapsed = {};
let roomCode = '';

function recordDiagnostic(label, kind, value) {
  const entry = diagnostics.get(label) ?? { console: [], pageErrors: [], socketErrors: [] };
  const target = entry[kind];
  if (target.length < 100) target.push(value);
  diagnostics.set(label, entry);
}

function capture(page, label) {
  const items = [];
  frames.set(label, items);
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') {
      recordDiagnostic(label, 'console', `${message.type()}: ${message.text()}`);
    }
  });
  page.on('pageerror', error => recordDiagnostic(label, 'pageErrors', String(error)));
  page.on('websocket', socket => {
    socket.on('socketerror', error => recordDiagnostic(label, 'socketErrors', String(error)));
    socket.on('framereceived', ({ payload }) => {
      try {
        const message = JSON.parse(String(payload));
        if (message.type === 'welcome' || message.type === 'snapshot') {
          items.push({ ...message, _receivedAt: Date.now() });
        }
      } catch {
        // Non-JSON frames are irrelevant to this black-box check.
      }
    });
  });
}

async function waitUntil(check, description, timeout = timeoutMs) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const detail = lastError ? ` Last check error: ${String(lastError)}` : '';
  throw new Error(`Timed out after ${timeout}ms: ${description}.${detail}`);
}

async function phase(page, value) {
  await waitUntil(
    async () => (await page.getByTestId('game-screen').getAttribute('data-phase').catch(() => null)) === value,
    `phase ${value} on ${page.url()}`,
  );
}

async function clickTarget(page, testId, target) {
  await page.getByTestId(testId).filter({ hasText: target }).first().click();
}

async function confirmNight(page, target, kind) {
  if (kind === 'mafia') {
    await clickTarget(page, 'night-target-option', target);
    await page.getByTestId('lock-in-button').waitFor({ state: 'visible' });
    await waitUntil(() => page.getByTestId('lock-in-button').isEnabled(), 'mafia lock enabled');
    await page.getByTestId('lock-in-button').click();
    return;
  }
  if (kind === 'watch') {
    await clickTarget(page, 'night-watch-option', target);
  } else {
    await clickTarget(page, 'night-target-option', target);
  }
  await waitUntil(() => page.getByTestId('night-confirm-button').isEnabled(), `${kind} confirm enabled`);
  await page.getByTestId('night-confirm-button').click();
}

async function vote(page, target) {
  if (target === 'no_murder') await page.getByTestId('vote-option-no-murder').click();
  else await clickTarget(page, 'vote-option', target);
  await waitUntil(() => page.getByTestId('confirm-vote-button').isEnabled(), 'vote confirm enabled');
  await page.getByTestId('confirm-vote-button').click();
}

function latestFrame(label, predicate) {
  return [...(frames.get(label) ?? [])].reverse().find(predicate);
}

async function assertHiddenDayBallots(label, since) {
  await waitUntil(
    () => (frames.get(label) ?? []).some(frame => frame._receivedAt >= since && frame.state?.game?.phase === 'day'),
    `post-action day snapshot for ${label}`,
  );
  const observed = (frames.get(label) ?? []).filter(frame => frame.state?.game?.phase === 'day');
  assert(observed.length > 0, `day snapshot captured for ${label}`);
  assert(
    observed.every(frame => frame.state.game.votes === undefined),
    `living player ${label} never receives the live ballot tally`,
  );
}

async function saveFailureDiagnostics(error) {
  const configured = process.env.MAFIA_LIVE_ARTIFACT_DIR?.trim();
  const artifactDir = configured || (await mkdtemp(join(tmpdir(), 'mafia-live-e2e-')));
  await mkdir(artifactDir, { recursive: true });
  const summary = {
    result: 'FAIL',
    base,
    roomCode,
    message: String(error),
    stack: error?.stack,
    elapsed,
    sessions: sessions.map(({ label, page }) => ({ label, url: page.url() })),
    diagnostics: Object.fromEntries(diagnostics),
  };
  await writeFile(join(artifactDir, 'failure.json'), `${JSON.stringify(summary, null, 2)}\n`);
  for (const { label, page } of sessions) {
    const safeLabel = label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    await page.screenshot({ path: join(artifactDir, `${safeLabel}.png`), fullPage: true }).catch(() => {});
    await writeFile(join(artifactDir, `${safeLabel}.html`), await page.content().catch(() => ''));
  }
  console.error(`Failure diagnostics written to ${artifactDir}`);
}

try {
  const options = {
    viewport: { width: 360, height: 780 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  };
  const hostCtx = await browser.newContext(options);
  contexts.push(hostCtx);
  const host = await hostCtx.newPage();
  sessions.push({ label: 'host', page: host });
  capture(host, 'host');

  await host.goto(base, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  const createAt = Date.now();
  await host.getByTestId('create-room').click();
  await waitUntil(() => /\/room\/[A-Z0-9]{5}$/.test(host.url()), 'host room URL');
  elapsed.createMs = Date.now() - createAt;
  roomCode = host.url().split('/room/')[1];

  const playerPages = new Map();
  for (const name of names) {
    const ctx = await browser.newContext(options);
    contexts.push(ctx);
    const page = await ctx.newPage();
    sessions.push({ label: name, page });
    playerPages.set(name, page);
    capture(page, name);
    const joinAt = Date.now();
    await page.goto(`${base}/room/${roomCode}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const joinNew = page.getByTestId('join-as-new');
    if (await joinNew.isVisible().catch(() => false)) await joinNew.click();
    await page.getByTestId('join-name-input').fill(name);
    await page.getByTestId('join-name-submit').click();
    await waitUntil(
      () => page.getByTestId('player-list').getByText(name).isVisible().catch(() => false),
      `${name} joined`,
    );
    elapsed[`join${name}Ms`] = Date.now() - joinAt;
  }

  await host.getByTestId('role-count-mafia-dec').click();
  await host.getByTestId('role-count-suicide_bomber-dec').click();
  await waitUntil(
    async () => (await host.getByTestId('role-count-villager').getAttribute('data-count')) === '2',
    'two villagers',
  );
  await waitUntil(() => host.getByTestId('start-game').isEnabled(), 'start enabled');
  const startAt = Date.now();
  await host.getByTestId('start-game').click();
  for (const page of playerPages.values()) await phase(page, 'night');
  elapsed.startToNightMs = Date.now() - startAt;

  await host.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await waitUntil(() => host.getByTestId('host-player-row').count().then(count => count === 5), 'host reconnect roster');
  const roleByName = {};
  for (const row of await host.getByTestId('host-player-row').all()) {
    const text = await row.innerText();
    const name = names.find(candidate => text.includes(candidate));
    assert(name, `row name in ${text}`);
    roleByName[name] = (await row.getByTestId('host-player-role').innerText()).trim().toLowerCase();
  }
  assert.deepEqual(
    Object.values(roleByName).sort(),
    ['angel', 'detective', 'mafia', 'villager', 'villager'].sort(),
    'host role assignment',
  );
  console.log(JSON.stringify({ stage: 'started', roomCode, roleByName }));

  const byRole = role => names.filter(name => roleByName[name] === role);
  const mafia = byRole('mafia')[0];
  const detective = byRole('detective')[0];
  const angel = byRole('angel')[0];
  const [victim, survivor] = byRole('villager');
  await waitUntil(
    () => Boolean(latestFrame(survivor, frame => frame.state?.game?.phase === 'night')),
    'living start snapshot',
  );
  const liveStart = latestFrame(survivor, frame => frame.state?.game?.phase === 'night');
  assert(liveStart, 'living start snapshot captured');
  assert(!liveStart.state.game.log.some(event => event.type === 'gameStarted'), 'no role assignments in living log');
  assert(liveStart.state.game.players.every(player => !player.roleId), 'no other roles in living roster');
  for (const page of playerPages.values()) {
    await waitUntil(() => page.getByTestId('role-reveal-dialog').count().then(count => count === 0), 'role reveal closed', 15_000);
  }

  await confirmNight(playerPages.get(mafia), victim, 'mafia');
  await confirmNight(playerPages.get(detective), mafia, 'detective');
  await playerPages.get(detective).reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await phase(playerPages.get(detective), 'night');
  await confirmNight(playerPages.get(angel), detective, 'angel');
  await confirmNight(playerPages.get(victim), detective, 'watch');
  const finalNightAt = Date.now();
  await confirmNight(playerPages.get(survivor), detective, 'watch');
  for (const page of playerPages.values()) await phase(page, 'dawn');
  elapsed.finalNightTapToDawnMs = Date.now() - finalNightAt;
  await waitUntil(
    () => playerPages.get(victim).getByTestId('dead-god-view').isVisible().catch(() => false),
    'dead player view',
  );
  assert((await playerPages.get(survivor).getByTestId('interstitial-lines').innerText()).includes(victim), 'victim named at dawn');
  const livingDawn = latestFrame(survivor, frame => frame.state?.game?.phase === 'dawn');
  assert(livingDawn && !livingDawn.state.game.log.some(event => ['attackAttempted', 'investigationResult'].includes(event.type)), 'night detail sealed');

  for (const name of names.filter(name => name !== victim)) {
    const page = playerPages.get(name);
    if (await page.getByTestId('role-reveal-dialog').isVisible().catch(() => false)) await page.keyboard.press('Escape');
    await waitUntil(() => page.getByTestId('role-reveal-dialog').count().then(count => count === 0), `${name} role dialog closed`);
  }
  await Promise.all(names.filter(name => name !== victim).map(name => playerPages.get(name).getByTestId('acknowledge-button').click()));
  for (const name of names.filter(name => name !== victim)) await phase(playerPages.get(name), 'day');

  const changedVoteAt = Date.now();
  await playerPages.get(detective).getByTestId('vote-option-no-murder').click();
  await clickTarget(playerPages.get(detective), 'vote-option', mafia);
  await waitUntil(() => playerPages.get(detective).getByTestId('confirm-vote-button').isEnabled(), 'changed vote confirm');
  await playerPages.get(detective).getByTestId('confirm-vote-button').click();
  await assertHiddenDayBallots(survivor, changedVoteAt);

  const angelVoteAt = Date.now();
  await vote(playerPages.get(angel), mafia);
  await assertHiddenDayBallots(survivor, angelVoteAt);
  const survivorVoteAt = Date.now();
  await vote(playerPages.get(survivor), mafia);
  await assertHiddenDayBallots(survivor, survivorVoteAt);
  const finalVoteAt = Date.now();
  await vote(playerPages.get(mafia), 'no_murder');
  await waitUntil(() => host.getByTestId('host-winner-splash').isVisible().catch(() => false), 'host game end');
  elapsed.finalVoteTapToEndMs = Date.now() - finalVoteAt;
  assert((await host.getByTestId('host-winner-splash').innerText()).toLowerCase().includes('village'), 'village win');

  await host.getByTestId('new-game').click();
  await host.getByTestId('new-game-confirm-confirm').click();
  await waitUntil(() => host.getByTestId('role-count-editor').isVisible(), 'rematch lobby');
  for (const page of playerPages.values()) await waitUntil(() => page.getByTestId('player-list').isVisible(), 'player returned to lobby');

  console.log(JSON.stringify({ result: 'PASS', base, roomCode, players: names.length, hostSeparate: true, winner: 'village', rematch: true, elapsed }));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', base, roomCode, message: String(error), stack: error?.stack }));
  await saveFailureDiagnostics(error);
  throw error;
} finally {
  await Promise.all(contexts.map(context => context.close().catch(() => {})));
  await browser.close();
}
