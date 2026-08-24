# Padel Booking Bot — GitHub Actions version

Runs a real headless Chrome browser (Playwright) every 5 minutes via GitHub
Actions, clicking through the club's site the same way you would by hand —
typing co-player names into the search box and clicking the real suggestions
— rather than replaying internal form data. This replaces the earlier
Cloudflare Worker version, which got silently blocked (see the /debug-login
test we ran: identical response whether the password was right or wrong).

## Why a public repo

GitHub Actions is completely free and unlimited on **public** repositories,
but capped at 2,000 minutes/month on private ones. At a 5-minute polling
cadence we'd blow through that cap fast, so this repo needs to be public.
Your secrets (password, tokens, player records) stay fully encrypted and
hidden either way — GitHub redacts secret values from every log line
automatically, and nothing in the code itself is sensitive.

## Setup

1. **Create a new GitHub repository** — public, any name (e.g. `padel-bot`).
   If you don't already have a GitHub account, sign up free at github.com.

2. **Push these files to it.** From this folder:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git push -u origin main
   ```

3. **Add secrets.** On the repo's GitHub page: Settings → Secrets and
   variables → Actions → New repository secret. Add each of these:

   | Secret name | Value |
   |---|---|
   | `MEMBER_LOGIN` | your club member number (e.g. `a57a`) |
   | `MEMBER_PASSWORD` | your club portal password |
   | `TELEGRAM_BOT_TOKEN` | from your padel Telegram bot (@BotFather) |
   | `TELEGRAM_CHAT_ID` | your Telegram chat id |
   | `PLAYERS_JSON` | paste the **entire contents** of `players.secret.json` as one value |
   | `CF_ACCOUNT_ID` | `d573197d788b4021a92363468ea4d2f1` (your Cloudflare account, reused from the Worker setup) |
   | `CF_KV_NAMESPACE_ID` | `e6f6c4486f7f4cdeaac49623d61ec5a9` (your existing BOOKINGS_KV namespace) |
   | `CF_API_TOKEN` | see below |

4. **Generate the Cloudflare API token** (`CF_API_TOKEN`): go to
   [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) →
   Create Token → use the "Edit Cloudflare Workers" template, or create a
   custom token scoped to your account with **Workers KV Storage: Edit**
   permission. Copy the token immediately (shown once) and paste it as the
   `CF_API_TOKEN` secret.

5. **Test it manually** before trusting the schedule: on the repo's GitHub
   page, go to the **Actions** tab → "Padel Booking Bot" workflow → "Run
   workflow" button → Run workflow. Watch it execute (click into the run,
   then the "book" job) — you'll see the same kind of log lines we were
   reading from `wrangler tail` before.

6. **If it fails**, scroll to the bottom of that run's page for an
   "Artifacts" section — download `debug-artifacts-<run-id>`, which contains
   a screenshot and the full page HTML from the moment it failed. Share
   those and I can tell you exactly what to fix, no more blind log-reading.

7. Once a manual run succeeds cleanly, the schedule in
   `.github/workflows/padel-bot.yml` takes over automatically — nothing
   else to do.

## Notes on what's still an assumption

I don't have live access to the site, so a few selectors are my best
inference from the HAR capture rather than confirmed against the real page:

- The login form field names (`_com_liferay_login_web_portlet_LoginPortlet_login`
  / `..._password`) — these matched the actual working POST request, so
  should be reliable.
- The "Add Player" autocomplete search box's element ID suffix (`player_input`)
  and the suggestion list's CSS class (`ui-autocomplete-item`) — these follow
  standard PrimeFaces conventions used throughout the rest of the page, but
  weren't directly confirmed for this specific interaction.

If either of those is slightly off, the screenshot/HTML artifacts on failure
will show exactly what's actually on the page at that point, which is enough
for me to fix it in one pass instead of guessing.

## Tuning

- **Preferred slots**: edit `PREFERRED_SLOTS` in `book.js` (currently 1-2 PM,
  then 4-5 PM).
- **Polling frequency**: edit the cron line in the workflow file. `*/5 * * * *`
  is the minimum GitHub allows; runs may lag a few extra minutes during busy
  periods on their shared runners.
- **Co-player order**: `coPlayers` in `players.secret.json` — the bot picks
  the first 3 not already booked elsewhere that day (4 total including you),
  in array order.
