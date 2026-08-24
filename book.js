/**
 * Toronto Cricket Club — Padel court auto-booking bot
 * Runs via GitHub Actions on a schedule (see .github/workflows/padel-bot.yml)
 *
 * Unlike the earlier Cloudflare Worker version, this drives a REAL headless
 * Chrome browser (Playwright) and clicks through the site exactly like a
 * human would — typing player names into the search box and clicking the
 * real autocomplete suggestions — rather than replaying internal form data.
 *
 * On ANY failure, this takes a full-page screenshot and saves the page's
 * HTML, both uploaded as workflow artifacts. If something breaks, download
 * those from the failed run's Actions page and share them — that's a much
 * faster way to diagnose than reading logs blind.
 *
 * Required GitHub Actions secrets (repo Settings > Secrets and variables > Actions):
 *   MEMBER_LOGIN, MEMBER_PASSWORD       - club login credentials
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *   PLAYERS_JSON                        - contents of players.secret.json (one line)
 *   CF_ACCOUNT_ID, CF_KV_NAMESPACE_ID   - reusing your existing Cloudflare KV
 *   CF_API_TOKEN                        - Cloudflare API token w/ Workers KV Storage:Edit
 */

const { chromium } = require("playwright");
const fs = require("fs");

const BASE = "https://torontocricketclub.com";
const LOGIN_URL = `${BASE}/web/pages/login`;
const PAGE_URL = `${BASE}/group/pages/padel-court-bookings`;

const PREFERRED_SLOTS = [
  { start: "01:00 PM", end: "02:00 PM" },
  { start: "04:00 PM", end: "05:00 PM" },
];

const DAYS_VISIBLE = 7; // tab bar shows today .. today+6
const ARTIFACT_DIR = "artifacts";

// ---------------------------------------------------------------------------
// Cloudflare KV, used purely as a small key/value database (no Worker involved)
// ---------------------------------------------------------------------------

const CF_KV_BASE = () =>
  `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/storage/kv/namespaces/${process.env.CF_KV_NAMESPACE_ID}/values`;

async function kvGet(key) {
  const resp = await fetch(`${CF_KV_BASE()}/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`KV get failed: ${resp.status}`);
  return resp.text();
}

async function kvPut(key, value) {
  const resp = await fetch(`${CF_KV_BASE()}/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` },
    body: value,
  });
  if (!resp.ok) throw new Error(`KV put failed: ${resp.status}`);
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
    }),
  });
}

// ---------------------------------------------------------------------------
// Date helpers (club is in Toronto)
// ---------------------------------------------------------------------------

function torontoDateOffset(offsetDays) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = +parts.find((p) => p.type === "year").value;
  const m = +parts.find((p) => p.type === "month").value;
  const d = +parts.find((p) => p.type === "day").value;
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + offsetDays);
  const mm = String(base.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(base.getUTCDate()).padStart(2, "0");
  const yyyy = base.getUTCFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

// ---------------------------------------------------------------------------
// Debug capture — called on any failure so we have something concrete to
// look at instead of guessing blind.
// ---------------------------------------------------------------------------

async function captureDebug(page, label) {
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const safeLabel = label.replace(/[^a-z0-9_-]/gi, "_");
    await page.screenshot({
      path: `${ARTIFACT_DIR}/${safeLabel}.png`,
      fullPage: true,
    });
    const html = await page.content();
    fs.writeFileSync(`${ARTIFACT_DIR}/${safeLabel}.html`, html);
    console.log(`Saved debug artifacts for: ${label}`);
  } catch (err) {
    console.error("Failed to capture debug artifacts:", err);
  }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

async function login(page) {
  await page.goto(LOGIN_URL, { waitUntil: "load" });

  // Liferay's login taglib renders inputs with `name` matching the portlet's
  // parameter names — same values we already confirmed work via the HAR.
  const loginInput = page.locator(
    'input[name="_com_liferay_login_web_portlet_LoginPortlet_login"]'
  );
  const passwordInput = page.locator(
    'input[name="_com_liferay_login_web_portlet_LoginPortlet_password"]'
  );

  await loginInput.waitFor({ timeout: 15000 });
  await loginInput.fill(process.env.MEMBER_LOGIN);
  await passwordInput.fill(process.env.MEMBER_PASSWORD);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    passwordInput.press("Enter"),
  ]);

  if (page.url().includes("/web/pages/login")) {
    await captureDebug(page, "login_failed");
    throw new Error(
      "Still on the login page after submitting — credentials rejected " +
        "or the form fields have different names than expected. Check " +
        "the login_failed screenshot/html artifact."
    );
  }
}

// ---------------------------------------------------------------------------
// Load one day's grid: which preferred slots are open, and which member IDs
// already have a reservation that day (club allows 1 padel booking/day/member)
// ---------------------------------------------------------------------------

async function loadDay(page, dayIndex, dateStr) {
  const tabSelector = `[id="_activities_WAR_northstarportlet_:activityForm:j_idt76:${dayIndex}:j_idt78"]`;
  await page.locator(tabSelector).click();
  // Wait for the actual thing we need (slot cells re-rendering) rather than
  // "networkidle", which can hang on pages with background polling scripts.
  await page.waitForSelector("td.data-col.slot [data-start-time]", {
    timeout: 15000,
    state: "attached",
  });
  await page.waitForTimeout(500); // let the AJAX swap fully settle

  const slots = await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll("td.data-col.slot"));
    return cells.map((td) => {
      const marker = td.querySelector("[data-start-time]");
      if (!marker) return null;
      const start = marker.getAttribute("data-start-time");
      const end = marker.getAttribute("data-end-time");
      const isOpen = td.classList.contains("open");
      const isReserved = td.classList.contains("reserved");
      const playerIdsEl = td.querySelector("[data-player-ids]");
      const playerIds = playerIdsEl
        ? playerIdsEl.getAttribute("data-player-ids")
        : null;
      return { start, end, isOpen, isReserved, playerIds };
    }).filter(Boolean);
  });

  const slotStatus = {};
  const bookedMemberIds = new Set();
  for (const s of slots) {
    // Some cells are neither genuinely "open" (bookable, shows a calendar
    // icon) nor "reserved" (has players) — e.g. buffer/blocked slots next
    // to a WPR reservation. Only treat explicit "open" as bookable.
    let status;
    if (s.isReserved) status = "reserved";
    else if (s.isOpen) status = "open";
    else status = "blocked";
    slotStatus[`${s.start}-${s.end}`] = status;
    if (s.playerIds) {
      for (const id of s.playerIds.split(",")) {
        const trimmed = id.trim();
        if (trimmed) bookedMemberIds.add(trimmed);
      }
    }
  }

  return { slotStatus, bookedMemberIds, dateStr };
}

// ---------------------------------------------------------------------------
// Attempt to book one slot on one date
// ---------------------------------------------------------------------------

async function attemptBooking(page, dateStr, slot, coPlayers) {
  const slotSelector = `td.data-col.slot:has(div[data-start-time="${slot.start}"][data-end-time="${slot.end}"])`;
  await page.locator(slotSelector).click();
  await page.waitForSelector("text=Reservation Information", {
    timeout: 10000,
  });

  for (let i = 0; i < coPlayers.length; i++) {
    const prevRow = i; // row 0 is self, always present already
    const rowIndex = i + 1;
    const player = coPlayers[i];

    const addButtonSelector = `[id="_activities_WAR_northstarportlet_:activityForm:playersTable:${prevRow}:j_idt2200"]`;
    await page.locator(addButtonSelector).click();
    await page.waitForTimeout(500);

    const searchInputSelector = `[id="_activities_WAR_northstarportlet_:activityForm:playersTable:${rowIndex}:player_input"]`;
    const searchInput = page.locator(searchInputSelector);
    await searchInput.waitFor({ timeout: 10000 });
    await searchInput.click();
    // PrimeFaces' remote autocomplete listens for real keystroke events to
    // trigger its search — .fill() sets the value directly and doesn't
    // dispatch those, so the dropdown never opens. Type it out for real.
    await searchInput.pressSequentially(player.lastName, { delay: 120 });

    // Match any suggestion list item containing the name, rather than
    // guessing at PrimeFaces' exact CSS class for this version of the site.
    const suggestion = page
      .locator("li")
      .filter({ hasText: player.lastName })
      .first();
    await suggestion.waitFor({ timeout: 10000 });
    await suggestion.click();
    await page.waitForTimeout(500);
  }

  const saveButtonSelector = `[id="_activities_WAR_northstarportlet_:activityForm:j_idt2266"]`;
  await page.locator(saveButtonSelector).click();

  // The save is an in-place AJAX update, not a page navigation — the last
  // screenshot showed it still mid-flight (loading spinner visible) after
  // only 1.5s, so wait properly for either outcome text to actually appear
  // rather than guessing a fixed short delay.
  await page
    .locator("body")
    .filter({ hasText: /Reservation created successfully|error|already booked|no longer available/i })
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => {}); // fall through to reading whatever's there either way

  const bodyText = await page.locator("body").innerText();
  const success = bodyText.includes("Reservation created successfully");
  return { success, bodyText };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const players = JSON.parse(process.env.PLAYERS_JSON);
  const selfMemberId = String(players.self.record.memberId);
  // Each co-player needs at least a lastName (for the search box) and
  // memberId (to check the day's already-booked list), matching the shape
  // already in players.secret.json.
  const coPlayerPool = players.coPlayers.map((p) => ({
    lastName: p.record.lastName,
    memberId: String(p.record.memberId),
    display: p.display,
  }));

  // Club rule: max 3 padel bookings per member within a 7-day period. We
  // enforce this by counting how many of the 7 visible days already show
  // your own memberId in an existing reservation.
  let bookingsInWindow = 0;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await login(page);
    await page.goto(PAGE_URL, { waitUntil: "load" });

    // We still never attempt a same-day booking (dayIndex 0) — finding free
    // co-players on a few hours' notice is unrealistic — but we DO need to
    // check today's existing bookings too, since the club's real 3-per-7-days
    // window appears to run "today through today+6", not just the 6 days
    // we can actually act on.
    for (let dayIndex = 0; dayIndex < DAYS_VISIBLE; dayIndex++) {
      const dateStr = torontoDateOffset(dayIndex);

      if (dayIndex > 0) {
        const alreadyBooked = await kvGet(`booked:${dateStr}`);
        if (alreadyBooked) {
          console.log(`${dateStr}: already booked, skipping`);
          continue;
        }
      }

      let day;
      try {
        day = await loadDay(page, dayIndex, dateStr);
      } catch (err) {
        await captureDebug(page, `loadDay_error_${dateStr}`);
        console.error(`Failed to load ${dateStr}, skipping this date:`, err.message);
        continue;
      }
      console.log(`${dateStr}: slot status =`, JSON.stringify(day.slotStatus));

      if (day.bookedMemberIds.has(selfMemberId)) {
        bookingsInWindow++;
        console.log(
          `${dateStr}: you already have a booking this day (${bookingsInWindow}/3 this week)`
        );
      }

      if (dayIndex === 0) continue; // counted above, never attempted

      if (bookingsInWindow >= 3) {
        console.log(
          `Already at the club's 3-bookings-per-7-days limit — skipping any new attempts.`
        );
        continue;
      }

      for (const slot of PREFERRED_SLOTS) {
        const key = `${slot.start}-${slot.end}`;
        if (day.slotStatus[key] !== "open") {
          console.log(`${dateStr} ${key}: not open, skipping`);
          continue;
        }
        console.log(`${dateStr} ${key}: OPEN — attempting booking`);

        const available = coPlayerPool.filter(
          (p) => !day.bookedMemberIds.has(p.memberId)
        );
        if (available.length < 3) {
          await sendTelegram(
            `⚠️ ${dateStr} ${slot.start}-${slot.end} is open, but fewer than 3 ` +
              `of your regular co-players are free that day (only ${available.length}). Skipping auto-book.`
          );
          continue;
        }

        const chosen = available.slice(0, 3);
        let result;
        try {
          result = await attemptBooking(page, dateStr, slot, chosen);
        } catch (err) {
          await captureDebug(page, `booking_error_${dateStr}_${key}`);
          console.error(`Booking attempt errored for ${dateStr} ${key}:`, err);
          await sendTelegram(
            `⚠️ Ran into an error trying to book ${dateStr} ${slot.start}-${slot.end}. ` +
              `Worth checking the club site manually — it's unlikely to have gone ` +
              `through, but the bot will retry automatically next run either way.`
          );
          await page.goto(PAGE_URL, { waitUntil: "load" }); // reset before continuing
          continue;
        }

        if (result.success) {
          await kvPut(`booked:${dateStr}`, "1");
          bookingsInWindow++;
          await sendTelegram(
            `✅ Booked Padel 1 on ${dateStr}, ${slot.start}-${slot.end}\n` +
              `With: ${chosen.map((p) => p.display.trim()).join(", ")}`
          );
          break; // move to next date
        } else {
          await captureDebug(page, `booking_failed_${dateStr}_${key}`);
          console.error(`Save did not confirm success for ${dateStr} ${key}`);
          await sendTelegram(
            `⚠️ Tried to book ${dateStr} ${slot.start}-${slot.end} but couldn't ` +
              `confirm it went through. Worth checking the club site manually — ` +
              `it may have actually succeeded despite this warning.`
          );
        }

        // Reload the page fresh before trying the next slot/date, since the
        // reservation panel leaves the page in a different state.
        await page.goto(PAGE_URL, { waitUntil: "load" });
      }
    }
  } catch (err) {
    await captureDebug(page, "fatal_error");
    console.error("Fatal error:", err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
