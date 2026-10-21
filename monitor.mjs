import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  EVENT,
  clockFromText,
  datePattern,
  eligibleDates,
  expandDateRange,
  fingerprintSlots,
  hasFreshCoverage,
  markdownSummary,
  mergeSlots,
  parseDates,
  parsePartySize,
  parseTime,
  selectShard,
  slotMatchesRequest,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESTAURANT_ID = '42739';
const EXPERIENCE_ID = '780938';
const EXPERIENCE_URL = 'https://www.opentable.com/booking/experiences-availability';
const TECHNICAL_ERROR = /unable to complete your request|technical team has been notified|something went wrong while.*(?:reserv|availab)|access denied|verify you are human|captcha/i;
const NO_AVAILABILITY = /no online availability|no availability|sold out|fully booked|requires more advanced notice|no tables/i;
const SLOT_SELECTOR = [
  'button[aria-label*="Reserve table at" i]',
  'a[aria-label*="Reserve table at" i]',
  '[data-testid*="time-slot" i][aria-label]',
  '[data-test*="time-slot" i][aria-label]',
].join(', ');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const cleanError = error => String(error?.message ?? error).split('\n', 1)[0].replaceAll(/\x1b\[[0-9;]*m/g, '');

function integerEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} through ${max}.`);
  }
  return value;
}

function todayInNewYork() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function configuration() {
  const maxDates = integerEnv('MAX_DATES_PER_RUN', 60, { min: 1, max: 62 });
  const configuredDates = process.env.DATES?.trim()
    ? parseDates(process.env.DATES, { maxDates })
    : parseDates(expandDateRange(process.env.DATE_START, process.env.DATE_END).join(','), { maxDates });
  const excludedDates = process.env.EXCLUDE_DATES?.trim()
    ? parseDates(process.env.EXCLUDE_DATES, { maxDates })
    : [];
  const excludedSet = new Set(excludedDates);
  const allEligibleDates = eligibleDates(configuredDates.filter(date => !excludedSet.has(date)), {
    today: todayInNewYork(),
    releaseDays: integerEnv('RELEASE_DAYS', 60, { min: 1, max: 90 }),
  });
  const shardCount = integerEnv('SHARD_COUNT', 1, { min: 1, max: 31 });
  const shardSlotMinutes = integerEnv('SHARD_SLOT_MINUTES', 60, { min: 5, max: 1440 });
  const automaticShardIndex = Math.floor(Date.now() / (shardSlotMinutes * 60 * 1000)) % shardCount;
  const requestedShardIndex = process.env.SHARD_INDEX?.trim();
  const shardIndex = !requestedShardIndex || requestedShardIndex.toLowerCase() === 'auto'
    ? automaticShardIndex
    : integerEnv('SHARD_INDEX', automaticShardIndex, { min: 0, max: shardCount - 1 });
  const dates = selectShard(allEligibleDates, { shardCount, shardIndex });
  const partySize = parsePartySize(process.env.PARTY_SIZE ?? '2');
  const startMinutes = parseTime(process.env.TIME_START ?? '11:00', 'TIME_START');
  const endMinutes = parseTime(process.env.TIME_END ?? '16:00', 'TIME_END');
  if (startMinutes > endMinutes) throw new Error('TIME_START must not be later than TIME_END.');

  return {
    dates,
    allEligibleDates,
    configuredDates,
    excludedDates,
    configuredRange: `${configuredDates.at(0)}–${configuredDates.at(-1)}`,
    shardCount,
    shardIndex,
    partySize,
    startMinutes,
    endMinutes,
    timeWindow: `${process.env.TIME_START ?? '11:00'}–${process.env.TIME_END ?? '16:00'} America/New_York`,
    delayMs: integerEnv('CHECK_DELAY_MS', 4000, { min: 2000, max: 60000 }),
    coverageMaxAgeHours: integerEnv('COVERAGE_MAX_AGE_HOURS', 8, { min: 1, max: 48 }),
    pageTimeoutMs: integerEnv('PAGE_TIMEOUT_MS', 30000, { min: 10000, max: 120000 }),
    resultFile: path.resolve(HERE, process.env.RESULT_FILE ?? 'result.json'),
    stateFile: path.resolve(HERE, process.env.STATE_FILE ?? '.state/last-result.json'),
    debugDir: path.resolve(HERE, process.env.DEBUG_DIR ?? 'debug'),
    headless: !['0', 'false', 'no'].includes(String(process.env.HEADLESS ?? 'true').toLowerCase()),
    browserChannel: process.env.BROWSER_CHANNEL?.trim() || undefined,
  };
}

function bookingUrl(date, partySize, time = '11:00') {
  const url = new URL(EXPERIENCE_URL);
  url.searchParams.set('rid', RESTAURANT_ID);
  url.searchParams.set('experienceId', EXPERIENCE_ID);
  url.searchParams.set('dateTime', `${date}T${time}:00`);
  url.searchParams.set('experienceEnhancements', 'true');
  url.searchParams.set('partySize', String(partySize));
  return url.href;
}

async function getBookingFrame(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = page.frames().filter(frame => !frame.isDetached() && frame.url().includes('/booking/experiences-availability'));
    for (const frame of frames) {
      let experienceMatches = false;
      try {
        experienceMatches = new URL(frame.url()).searchParams.get('experienceId') === EXPERIENCE_ID;
      } catch {}
      if (!experienceMatches) continue;
      const hasControls = await frame.locator('select[data-test="party-size-picker"], [data-testid="day-picker-overlay"]').count().catch(() => 0);
      if (hasControls) return frame;
    }
    await sleep(200);
  }
  return null;
}

async function verifyState(scope, date, partySize) {
  const selectedParty = await scope.locator('select[data-test="party-size-picker"]').inputValue({ timeout: 3000 }).catch(() => '');
  if (selectedParty !== String(partySize)) {
    throw new Error(`OpenTable showed party size ${selectedParty || 'unknown'} instead of ${partySize}.`);
  }

  const expectedDate = datePattern(date);
  const dateControls = scope.locator('[data-testid="day-picker-overlay"], [data-test="day-picker"], [aria-label*="date" i], input[type="date"]');
  const values = [];
  for (const control of await dateControls.all()) {
    values.push(await control.getAttribute('aria-label').catch(() => ''));
    values.push(await control.getAttribute('value').catch(() => ''));
    values.push(await control.innerText().catch(() => ''));
  }
  if (!values.some(value => value && (value.includes(date) || expectedDate.test(value)))) {
    throw new Error(`OpenTable did not confirm the requested date ${date}.`);
  }
}

async function extractSlots(scope, date, config) {
  const slots = [];
  for (const element of await scope.locator(SLOT_SELECTOR).all()) {
    if (!await element.isVisible().catch(() => false) || !await element.isEnabled().catch(() => false)) continue;
    const label = ((await element.getAttribute('aria-label')) || (await element.innerText().catch(() => ''))).trim();
    if (!slotMatchesRequest(label, date, config.partySize)) continue;
    const clock = clockFromText(label);
    if (!clock || clock.minutes < config.startMinutes || clock.minutes > config.endMinutes) continue;
    slots.push({
      date,
      time: clock.label,
      url: bookingUrl(date, config.partySize, `${String(Math.floor(clock.minutes / 60)).padStart(2, '0')}:${String(clock.minutes % 60).padStart(2, '0')}`),
    });
  }
  return [...new Map(slots.map(slot => [`${slot.date}|${slot.time}`, slot])).values()]
    .sort((left, right) => left.date.localeCompare(right.date)
      || clockFromText(left.time).minutes - clockFromText(right.time).minutes);
}

async function bodyText(scope) {
  return scope.locator('body').innerText({ timeout: 3000 }).catch(() => scope.innerText({ timeout: 3000 }).catch(() => ''));
}

async function saveDebug(page, date, debugDir) {
  await fs.mkdir(debugDir, { recursive: true });
  const safeDate = date.replaceAll(/[^0-9-]/g, '_');
  await page.screenshot({ path: path.join(debugDir, `${safeDate}.png`), fullPage: true, timeout: 10000 }).catch(() => {});
  const details = {
    url: page.url(),
    title: await page.title().catch(() => ''),
    frames: page.frames().map(frame => frame.url()),
    visibleText: (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).slice(0, 5000),
  };
  await fs.writeFile(path.join(debugDir, `${safeDate}.json`), `${JSON.stringify(details, null, 2)}\n`).catch(() => {});
}

async function checkDate(browser, date, config) {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/New_York' });
  const page = await context.newPage();
  const blockedResponses = [];
  page.on('response', response => {
    if (response.status() === 403 || response.status() === 429) {
      if (/opentable\.com\/dapi\/fe\/(?:gql|human)|opentable\.com\/booking\/experiences-availability/i.test(response.url())) {
        blockedResponses.push(`${response.status()} ${response.url()}`);
      }
    }
  });

  try {
    console.log(`Checking ${date} for ${config.partySize} guest${config.partySize === 1 ? '' : 's'}…`);
    let navigationError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await page.goto(bookingUrl(date, config.partySize), { waitUntil: 'domcontentloaded', timeout: config.pageTimeoutMs });
        navigationError = null;
        break;
      } catch (error) {
        navigationError = error;
        if (attempt < 2) await sleep(1500);
      }
    }
    if (navigationError) throw navigationError;
    await page.getByRole('button', { name: /^(?:accept all cookies|accept all|allow all cookies)$/i }).first().click({ timeout: 1500 }).catch(() => {});
    await page.getByRole('heading', { name: EVENT, exact: true }).first().waitFor({ state: 'visible', timeout: 15000 });
    const scope = await getBookingFrame(page, 15000);
    if (!scope) throw new Error('The Holiday Afternoon Tea booking controls did not load.');
    await verifyState(scope, date, config.partySize);

    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const text = await bodyText(scope);
      if (TECHNICAL_ERROR.test(text)) throw new Error('OpenTable displayed a technical error or human-verification challenge.');
      if (blockedResponses.length) throw new Error(`OpenTable blocked an availability request (${blockedResponses[0].split(' ')[0]}).`);
      const slots = await extractSlots(scope, date, config);
      if (slots.length) return slots;
      if (NO_AVAILABILITY.test(text)) return [];
      await sleep(500);
    }
    throw new Error('OpenTable did not show verified slots or an explicit no-availability message before the timeout.');
  } catch (error) {
    await saveDebug(page, date, config.debugDir);
    throw error;
  } finally {
    await context.close();
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function sendWebhook(result, summary) {
  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return;
  const headers = { 'content-type': 'application/json' };
  if (process.env.ALERT_WEBHOOK_BEARER) headers.authorization = `Bearer ${process.env.ALERT_WEBHOOK_BEARER}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: summary, content: summary, event: EVENT, result }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Alert webhook returned HTTP ${response.status}.`);
}

async function setGitHubOutputs(result) {
  if (!process.env.GITHUB_OUTPUT) return;
  await fs.appendFile(process.env.GITHUB_OUTPUT, `status=${result.status}\nnotify=${result.notify}\nresult_file=${result.resultFile}\n`);
}

async function main() {
  let config;
  try {
    config = configuration();
  } catch (error) {
    console.error(`Configuration error: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  let browser;
  const currentSlots = [];
  const checkedDates = [];
  const errors = [];
  try {
    try {
      if (config.dates.length) {
        browser = await chromium.launch({
          headless: config.headless,
          channel: config.browserChannel,
          args: ['--disable-http2'],
        });
        for (let index = 0; index < config.dates.length; index += 1) {
          const date = config.dates[index];
          try {
            currentSlots.push(...await checkDate(browser, date, config));
            checkedDates.push(date);
          } catch (error) {
            errors.push({ date, message: cleanError(error) });
            console.error(`${date}: ${cleanError(error)}`);
          }
          if (index < config.dates.length - 1) await sleep(config.delayMs);
        }
      } else {
        console.log('No configured dates are currently within the rolling release window.');
      }
    } catch (error) {
      errors.push({ message: `Browser launch failed: ${cleanError(error)}` });
      console.error(errors.at(-1).message);
    }
  } finally {
    await browser?.close().catch(() => {});
  }

  const previous = await readJson(config.stateFile);
  const slots = mergeSlots(previous?.slots, currentSlots, checkedDates, config.allEligibleDates);
  const checkedAt = new Date().toISOString();
  const eligibleSet = new Set(config.allEligibleDates);
  const checkedAtByDate = Object.fromEntries(Object.entries(previous?.checkedAtByDate ?? {})
    .filter(([date]) => eligibleSet.has(date)));
  for (const date of checkedDates) checkedAtByDate[date] = checkedAt;
  const coverageComplete = hasFreshCoverage(config.allEligibleDates, checkedAtByDate, {
    now: Date.parse(checkedAt),
    maxAgeHours: config.coverageMaxAgeHours,
  });
  const status = slots.length
    ? 'available'
    : errors.length && checkedDates.length === 0
      ? 'error'
      : coverageComplete
        ? 'unavailable'
        : 'partial';
  const fingerprint = fingerprintSlots(slots);
  const notify = status === 'available' && (previous?.status !== 'available' || previous?.fingerprint !== fingerprint);
  const result = {
    status,
    notify,
    event: EVENT,
    checkedAt,
    dates: config.dates,
    checkedDates,
    eligibleDateCount: config.allEligibleDates.length,
    configuredRange: config.configuredRange,
    excludedDates: config.excludedDates,
    shardCount: config.shardCount,
    shardIndex: config.shardIndex,
    coverageComplete,
    partySize: config.partySize,
    timeWindow: config.timeWindow,
    slots,
    errors,
    fingerprint,
    resultFile: path.relative(HERE, config.resultFile),
  };
  let notificationSucceeded = true;
  if (notify) {
    try {
      await sendWebhook(result, markdownSummary(result));
    } catch (error) {
      notificationSucceeded = false;
      errors.push({ message: cleanError(error) });
      console.error(cleanError(error));
      process.exitCode = 1;
    }
  }
  const summary = markdownSummary(result);
  console.log(`\n${summary}`);
  await writeJson(config.resultFile, result);
  await fs.writeFile(path.join(path.dirname(config.resultFile), 'result.md'), `${summary}\n`);
  await setGitHubOutputs(result);

  if (notificationSucceeded && (checkedDates.length || !errors.length)) {
    await writeJson(config.stateFile, {
      status,
      fingerprint,
      checkedAt: result.checkedAt,
      slots,
      checkedAtByDate,
    });
  }
  if (errors.length) process.exitCode = 1;
}

await main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
