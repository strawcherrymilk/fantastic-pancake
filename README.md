# Plaza Holiday Afternoon Tea monitor

This is a read-only monitor for the **Holiday Afternoon Tea** experience at
The Palm Court at The Plaza Hotel. It checks explicitly configured dates and
times, reports genuine enabled reservation slots, and never clicks a slot or
submits a booking.

The OpenTable listing currently describes the experience as running from
November 18, 2026 through January 12, 2027 for parties of 1–6, with dates
released on a rolling 60-day basis.

## Local setup

You need Node.js 20 or newer.

```sh
cd plaza-tea-monitor
npm ci
cp .env.example .env
```

The supplied local configuration uses your installed Google Chrome. If you
remove `BROWSER_CHANNEL=chrome`, install Playwright's browser once with
`npx playwright install chromium`.

Edit `.env` with the dates, party size, and time range you would actually
accept. Then run:

```sh
./run-monitor.sh
```

The result is written to `result.json`. A new availability result exits
successfully and prints booking links. Site errors, blocks, and human checks
exit nonzero instead of being mistaken for "no availability."

The example configuration uses a normal local Chrome window because the live
test found that OpenTable stalled a headless browser while the normal Chrome
session completed. Each scheduled check opens a short-lived window. You can
try `HEADLESS=true`, but treat repeated failures as a signal to switch it back.

### Optional webhook alert

Set `ALERT_WEBHOOK_URL` in `.env` to a Slack-compatible or Discord-compatible
JSON webhook. The monitor sends an alert only when availability first appears
or the set of available slots changes. State is stored in
`.state/last-result.json`.

### cron

First run the command manually. Then edit your crontab with `crontab -e` and
add a line like this (replace the path if the checkout moves):

```cron
17 * * * * /Users/amanda/Documents/ChatGPT/PinPal/plaza-tea-monitor/run-monitor.sh >> /Users/amanda/Documents/ChatGPT/PinPal/plaza-tea-monitor/monitor.log 2>&1
```

The full-season configuration should use small rotating batches. The GitHub
workflow demonstrates a seven-batch rotation; the monitor still checks only
dates currently inside the rolling 60-day release window.

## GitHub Actions

This directory is a self-contained repository. Its workflow at
`.github/workflows/monitor.yml` runs every 15 minutes and can also be started
manually. Each run checks one of seven rotating date batches, so the complete
rolling window is covered about every 1 hour 45 minutes without sending a large burst
of requests. The cloud runner uses a normal Chromium window inside a virtual
display because that is the browser mode OpenTable accepted during the local
live test.

The committed workflow is configured for four guests, any tea seating from
11:00 AM through 4:00 PM, and the complete November 18, 2026 through January
12, 2027 season. Each run automatically skips past dates and dates that are
more than 60 days away, matching the restaurant's rolling release policy.
Successful results are merged across batches. An open availability issue is
closed only after every currently eligible date has a recent successful check;
a partial or blocked batch never turns a previous alert into "unavailable."

When slots appear, the workflow creates or updates one GitHub issue labeled
`tea-availability`; when they disappear, it closes that issue. To also send a
webhook, add an Actions secret named `TEA_ALERT_WEBHOOK_URL`. If you rely only
on the issue, watch the repository and enable GitHub issue notifications so
the new issue reaches you.

GitHub-hosted browser traffic may occasionally be blocked by OpenTable. Those
runs fail visibly and upload debug artifacts. If that happens consistently,
use local cron with installed Chrome by setting `BROWSER_CHANNEL=chrome`.

## Important behavior

- This is a notifier, not an autobooker. Availability can disappear before
  you finish booking.
- OpenTable can change its page at any time. A failed check is reported as an
  error, not as "sold out."
- Keep checks modest and review OpenTable's current terms before operating the
  monitor.
