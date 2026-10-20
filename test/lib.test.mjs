import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDays,
  clockFromText,
  datePattern,
  eligibleDates,
  expandDateRange,
  fingerprintSlots,
  hasFreshCoverage,
  mergeSlots,
  parseDates,
  parsePartySize,
  parseTime,
  selectShard,
  slotMatchesRequest,
} from '../lib.mjs';

test('dates are deduplicated, sorted, and restricted to the event season', () => {
  assert.deepEqual(parseDates('2026-12-20, 2026-11-18,2026-12-20'), ['2026-11-18', '2026-12-20']);
  assert.throws(() => parseDates('2026-11-17'), /outside/);
  assert.throws(() => parseDates(''), /required/);
});

test('date ranges expand inclusively and rolling-release filtering skips ineligible dates', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(expandDateRange('2026-11-18', '2026-11-20'), [
    '2026-11-18', '2026-11-19', '2026-11-20',
  ]);
  assert.deepEqual(
    eligibleDates(['2026-11-18', '2026-12-19', '2026-12-20'], { today: '2026-10-20', releaseDays: 60 }),
    ['2026-11-18', '2026-12-19'],
  );
});

test('party size accepts only the published 1–6 range', () => {
  assert.equal(parsePartySize('4'), 4);
  assert.throws(() => parsePartySize('7'), /1 through 6/);
});

test('24-hour times are parsed and validated', () => {
  assert.equal(parseTime('11:30'), 690);
  assert.equal(parseTime('16:00'), 960);
  assert.throws(() => parseTime('25:00'), /valid/);
});

test('reservation labels yield one normalized clock time', () => {
  assert.deepEqual(clockFromText('Reserve table on December 15, 2026 at 1:30 p.m. for a party of 4'), {
    minutes: 810,
    label: '1:30 PM',
  });
  assert.equal(clockFromText('11:00 AM or 11:30 AM'), null);
});

test('date pattern matches long, short, and ISO labels', () => {
  const pattern = datePattern('2026-12-15');
  assert.match('December 15, 2026', pattern);
  assert.match('Dec 15 2026', pattern);
  assert.match('2026-12-15', pattern);
});

test('only reservation labels for the exact date and party are accepted', () => {
  const label = 'Reserve table at The Palm Court on December 15, 2026 at 1:30 PM for a party of 4';
  assert.equal(slotMatchesRequest(label, '2026-12-15', 4), true);
  assert.equal(slotMatchesRequest(label, '2026-12-16', 4), false);
  assert.equal(slotMatchesRequest(label, '2026-12-15', 2), false);
  assert.equal(slotMatchesRequest('Time preference: 1:30 PM for 4 people', '2026-12-15', 4), false);
});

test('slot fingerprints are stable regardless of order', () => {
  const first = { date: '2026-12-15', time: '1:30 PM', url: 'https://example/a' };
  const second = { date: '2026-12-16', time: '11:00 AM', url: 'https://example/b' };
  assert.equal(fingerprintSlots([first, second]), fingerprintSlots([second, first]));
});

test('date sharding covers every date exactly once in small batches', () => {
  const dates = expandDateRange('2026-11-18', '2027-01-12');
  const shards = Array.from({ length: 7 }, (_, shardIndex) => selectShard(dates, {
    shardCount: 7,
    shardIndex,
  }));
  assert.ok(shards.every(shard => shard.length === 8));
  assert.deepEqual(shards.flat().sort(), dates);
});

test('slot merging replaces checked dates and retains unscanned dates', () => {
  const previous = [
    { date: '2026-12-15', time: '1:30 PM', url: 'https://example/old' },
    { date: '2026-12-16', time: '11:00 AM', url: 'https://example/keep' },
  ];
  const current = [{ date: '2026-12-15', time: '2:00 PM', url: 'https://example/new' }];
  assert.deepEqual(mergeSlots(previous, current, ['2026-12-15'], ['2026-12-15', '2026-12-16']), [
    current[0], previous[1],
  ]);
});

test('coverage is complete only when every active date was checked recently', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  const coverage = {
    '2026-11-18': '2026-10-20T11:00:00Z',
    '2026-11-19': '2026-10-20T10:00:00Z',
  };
  assert.equal(hasFreshCoverage(Object.keys(coverage), coverage, { now, maxAgeHours: 8 }), true);
  assert.equal(hasFreshCoverage([...Object.keys(coverage), '2026-11-20'], coverage, { now, maxAgeHours: 8 }), false);
  assert.equal(hasFreshCoverage(Object.keys(coverage), coverage, { now, maxAgeHours: 1 }), false);
});
