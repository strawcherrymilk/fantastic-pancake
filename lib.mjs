export const EVENT = 'Holiday Afternoon Tea';
export const EVENT_MIN_DATE = '2026-11-18';
export const EVENT_MAX_DATE = '2027-01-12';

export function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseDates(value, { maxDates = 14 } = {}) {
  const dates = [...new Set(String(value ?? '')
    .split(/[\s,]+/)
    .map(item => item.trim())
    .filter(Boolean))].sort();

  if (!dates.length) {
    throw new Error('DATES is required. Use comma-separated dates such as DATES=2026-12-15,2026-12-16.');
  }
  if (dates.length > maxDates) {
    throw new Error(`DATES contains ${dates.length} dates; the per-run limit is ${maxDates}.`);
  }
  for (const date of dates) {
    if (!isIsoDate(date)) throw new Error(`Invalid date "${date}"; dates must use YYYY-MM-DD.`);
    if (date < EVENT_MIN_DATE || date > EVENT_MAX_DATE) {
      throw new Error(`${date} is outside the ${EVENT} season (${EVENT_MIN_DATE} through ${EVENT_MAX_DATE}).`);
    }
  }
  return dates;
}

export function addDays(date, days) {
  const parsed = new Date(`${date}T12:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function expandDateRange(start, end) {
  if (!isIsoDate(start) || !isIsoDate(end)) {
    throw new Error('DATE_START and DATE_END must use YYYY-MM-DD.');
  }
  if (start > end) throw new Error('DATE_START must not be later than DATE_END.');
  const dates = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  return dates;
}

export function eligibleDates(dates, { today, releaseDays = 60 } = {}) {
  if (!isIsoDate(today)) throw new Error('today must use YYYY-MM-DD.');
  const cutoff = addDays(today, releaseDays);
  return dates.filter(date => date >= today && date <= cutoff);
}

export function selectShard(dates, { shardCount = 1, shardIndex = 0 } = {}) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error('shardCount must be a positive whole number.');
  }
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error('shardIndex must identify one of the configured shards.');
  }
  return dates.filter((_, index) => index % shardCount === shardIndex);
}

export function parsePartySize(value) {
  const partySize = Number(value);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 6) {
    throw new Error('PARTY_SIZE must be a whole number from 1 through 6.');
  }
  return partySize;
}

export function parseTime(value, name = 'time') {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) throw new Error(`${name} must use 24-hour HH:MM format.`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`${name} must be a valid 24-hour time.`);
  return hours * 60 + minutes;
}

export function clockFromText(value) {
  const matches = [...String(value).matchAll(/\b(0?[1-9]|1[0-2])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/gi)];
  if (matches.length !== 1) return null;
  const hours = Number(matches[0][1]);
  const minutes = Number(matches[0][2] ?? 0);
  const meridiem = matches[0][3].replaceAll('.', '').toLowerCase();
  const totalMinutes = (hours % 12) * 60 + minutes + (meridiem === 'pm' ? 12 * 60 : 0);
  const labelHours = totalMinutes === 0 ? 12 : Math.floor(totalMinutes / 60) > 12
    ? Math.floor(totalMinutes / 60) - 12
    : Math.floor(totalMinutes / 60);
  return {
    minutes: totalMinutes,
    label: `${labelHours}:${String(minutes).padStart(2, '0')} ${meridiem.toUpperCase()}`,
  };
}

export function datePattern(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  const month = parsed.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const shortMonth = parsed.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = parsed.getUTCDate();
  const year = parsed.getUTCFullYear();
  return new RegExp(`(?:${month}|${shortMonth})\\s+${day}(?:st|nd|rd|th)?(?:,)?\\s+${year}|${date}`, 'i');
}

export function slotMatchesRequest(label, date, partySize) {
  const partyPattern = new RegExp(`\\bparty of ${partySize}\\b|\\b${partySize}\\s*(?:people|persons?|guests?|diners?)\\b`, 'i');
  return /reserve table at/i.test(label) && datePattern(date).test(label) && partyPattern.test(label);
}

export function fingerprintSlots(slots) {
  return [...slots]
    .map(slot => `${slot.date}|${slot.time}|${slot.url}`)
    .sort()
    .join('\n');
}

export function mergeSlots(previousSlots, currentSlots, checkedDates, eligible) {
  const eligibleSet = new Set(eligible);
  const checkedSet = new Set(checkedDates);
  const retained = (Array.isArray(previousSlots) ? previousSlots : [])
    .filter(slot => eligibleSet.has(slot.date) && !checkedSet.has(slot.date));
  return [...new Map([...retained, ...currentSlots]
    .filter(slot => eligibleSet.has(slot.date))
    .map(slot => [`${slot.date}|${slot.time}`, slot])).values()]
    .sort((left, right) => left.date.localeCompare(right.date)
      || (clockFromText(left.time)?.minutes ?? 0) - (clockFromText(right.time)?.minutes ?? 0));
}

export function hasFreshCoverage(dates, checkedAtByDate, { now = Date.now(), maxAgeHours = 8 } = {}) {
  const cutoff = now - maxAgeHours * 60 * 60 * 1000;
  return dates.every(date => {
    const checkedAt = Date.parse(checkedAtByDate?.[date] ?? '');
    return Number.isFinite(checkedAt) && checkedAt >= cutoff;
  });
}

export function markdownSummary(result) {
  const heading = result.status === 'available'
    ? `Holiday Afternoon Tea is available for ${result.partySize}!`
    : result.status === 'unavailable'
      ? 'No matching Holiday Afternoon Tea reservations were found.'
      : result.status === 'partial'
        ? 'A partial Holiday Afternoon Tea batch completed; no matching reservations were found in this batch.'
        : 'The Holiday Afternoon Tea check could not be completed.';
  const lines = [
    heading,
    '',
    `Checked: ${result.checkedAt}`,
    `Configured range: ${result.configuredRange ?? result.dates.join(', ')}`,
    ...(result.excludedDates?.length ? [`Excluded dates: ${result.excludedDates.join(', ')}`] : []),
    `Rolling-window dates: ${result.eligibleDateCount ?? result.dates.length}`,
    `Batch: ${(result.shardIndex ?? 0) + 1}/${result.shardCount ?? 1}`,
    `Dates attempted this run: ${result.dates.length ? result.dates.join(', ') : 'none currently eligible'}`,
    `Time window: ${result.timeWindow}`,
  ];
  if (result.slots.length) {
    lines.push('', ...result.slots.map(slot => `- ${slot.date} at ${slot.time}: ${slot.url}`));
  }
  if (result.errors.length) {
    lines.push('', 'Errors:', ...result.errors.map(error => `- ${error.date ?? 'monitor'}: ${error.message}`));
  }
  return lines.join('\n');
}
