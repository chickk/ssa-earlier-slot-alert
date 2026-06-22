import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFile } from "node:child_process";
import { chromium } from "playwright";

const CONFIG_PATH = path.resolve("config.json");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error("Missing config.json. Copy config.example.json to config.json and edit it first.");
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

  if (!Array.isArray(config.zipCodes) || config.zipCodes.length === 0) {
    throw new Error("config.json must include at least one ZIP code in zipCodes.");
  }

  if (!config.currentAppointmentDate) {
    throw new Error("config.json must include currentAppointmentDate in YYYY-MM-DD format.");
  }

  return {
    startUrl: config.startUrl ?? "https://secure.ssa.gov/RIL/SiView.action",
    zipCodes: config.zipCodes.map(String),
    currentAppointmentDate: new Date(`${config.currentAppointmentDate}T00:00:00`),
    checkEveryMinutes: Number(config.checkEveryMinutes ?? 5),
    betweenZipDelayMs: Number(config.betweenZipDelayMs ?? 3000),
    browserProfileDir: config.browserProfileDir ?? ".ssa-browser-profile",
    headless: Boolean(config.headless),
    notifyOnEveryEarlierResult: Boolean(config.notifyOnEveryEarlierResult),
    debugSnapshots: config.debugSnapshots !== false
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notify(title, message) {
  console.log(`${title}: ${message}`);

  if (process.platform !== "darwin") {
    return;
  }

  execFile("osascript", [
    "-e",
    `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`
  ]);
}

function parseDateFromText(text) {
  const slashDate = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (slashDate) {
    const [, month, day, year] = slashDate;
    return new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00`);
  }

  const monthDate = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/i
  );

  if (monthDate) {
    const [, monthName, day, year] = monthDate;
    const monthIndex = new Date(`${monthName} 1, 2000`).getMonth() + 1;
    return new Date(`${year}-${String(monthIndex).padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00`);
  }

  return null;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function compareDateOnly(left, right) {
  return formatDate(left).localeCompare(formatDate(right));
}

async function pressEnterToContinue(message) {
  const rl = readline.createInterface({ input, output });
  await rl.question(message);
  rl.close();
}

async function isLoading(page) {
  return Boolean(
    await page
      .locator('uef-dialog[data-testid="waiting-indicator"][open], [data-testid="waiting-indicator"][open]')
      .count()
      .catch(() => 0)
  );
}

async function waitForLoadingToFinish(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await isLoading(page))) {
      return;
    }

    await page.waitForTimeout(500);
  }

  throw new Error("SSA page is still showing Loading, Please Wait.");
}

function isClosedBrowserError(error) {
  return /Target page, context or browser has been closed/i.test(error.message);
}

async function findZipInput(page) {
  const inputCandidates = [
    page.getByLabel(/zip code/i),
    page.getByRole("textbox").first(),
    page.locator('input[name*="zip" i]').first(),
    page.locator('input[id*="zip" i]').first(),
    page.locator('input[type="text"]').first()
  ];

  for (const locator of inputCandidates) {
    const candidate = locator.first();
    if ((await candidate.count().catch(() => 0)) && (await candidate.isVisible().catch(() => false))) {
      return candidate;
    }
  }

  return null;
}

async function hasZipInput(page) {
  return Boolean(await findZipInput(page));
}

async function fillZipCode(page, zipCode) {
  const zipInput = await findZipInput(page);

  if (zipInput) {
    await zipInput.fill(zipCode);
    return;
  }

  throw new Error("Could not find the ZIP code input on the current page.");
}

function safeFileLabel(label) {
  return label.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
}

async function saveDebugSnapshot(page, label) {
  const debugDir = path.resolve("work", "debug");
  fs.mkdirSync(debugDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = path.join(debugDir, `${stamp}-${safeFileLabel(label)}`);
  const bodyText = await page.locator("body").innerText().catch((error) => `Could not read body text: ${error.message}`);
  const html = await page.content().catch((error) => `Could not read HTML: ${error.message}`);
  const buttons = await page
    .locator("button, a, input, select, textarea")
    .evaluateAll((elements) =>
      elements.map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type"),
        name: el.getAttribute("name"),
        id: el.getAttribute("id"),
        value: el.getAttribute("value"),
        ariaLabel: el.getAttribute("aria-label"),
        text: el.textContent?.trim(),
        visibleText: el.innerText?.trim()
      }))
    )
    .catch((error) => [{ error: error.message }]);

  fs.writeFileSync(`${base}.txt`, `URL: ${page.url()}\n\n${bodyText}\n\nELEMENTS:\n${JSON.stringify(buttons, null, 2)}\n`);
  fs.writeFileSync(`${base}.html`, html);
  await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});

  console.log(`Saved debug snapshot: ${base}.txt`);
}

async function clickNext(page) {
  await waitForLoadingToFinish(page);

  const buttonCandidates = [
    page.locator("#next-btn").first(),
    page.locator('button[name="next-btn"]').first(),
    page.getByRole("button", { name: /^next$/i }),
    page.getByRole("link", { name: /^next$/i }),
    page.locator('input[type="submit"][value*="Next" i]').first(),
    page.locator('button:has-text("Next")').first()
  ];

  for (const locator of buttonCandidates) {
    if (await locator.count()) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        locator.first().click()
      ]);
      await page.waitForTimeout(1500);
      await waitForLoadingToFinish(page).catch(() => {});
      return;
    }
  }

  throw new Error("Could not find the Next button on the current page.");
}

async function waitForZipSearchPage(page, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await waitForLoadingToFinish(page, 1000).catch(() => {});

    if (await hasZipInput(page)) {
      return true;
    }

    await page.waitForTimeout(250);
  }

  return false;
}

async function askUserToReturnToZipPage(page) {
  console.log("The ZIP Code field is not visible.");
  console.log("In Chrome, return to the SSA page that shows the ZIP Code field. Do not use the navigation-error page.");
  await pressEnterToContinue("Press Enter here after the ZIP Code field is visible...");

  if (!(await waitForZipSearchPage(page, 5000))) {
    throw new Error("Still cannot find the ZIP code input after waiting.");
  }
}

async function ensureZipSearchReady(page) {
  await waitForLoadingToFinish(page);

  if (await waitForZipSearchPage(page, 1000)) {
    return;
  }

  await askUserToReturnToZipPage(page);
}

async function returnToZipSearch(page) {
  await waitForLoadingToFinish(page).catch(() => {});

  if (await waitForZipSearchPage(page, 1000)) {
    return;
  }

  const backCandidates = [
    page.getByRole("button", { name: /back|previous|change|edit/i }),
    page.getByRole("link", { name: /back|previous|change|edit/i }),
    page.locator('input[type="button"][value*="Back" i]').first(),
    page.locator('input[type="submit"][value*="Back" i]').first(),
    page.locator('button:has-text("Back")').first()
  ];

  for (const locator of backCandidates) {
    const candidate = locator.first();
    if ((await candidate.count().catch(() => 0)) && (await candidate.isVisible().catch(() => false))) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        candidate.click()
      ]);

      if (await waitForZipSearchPage(page, 5000)) {
        return;
      }
    }
  }

  await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});

  if (await waitForZipSearchPage(page, 5000)) {
    return;
  }

  await askUserToReturnToZipPage(page);
}

async function extractSlots(page) {
  const timeslotButtons = await page
    .locator('button[id^="timeslot-button-"], button[name^="timeslot-button-"]')
    .evaluateAll((buttons) => buttons.map((button) => button.innerText.trim()).filter(Boolean))
    .catch(() => []);

  if (timeslotButtons.length > 0) {
    return buildSlots(timeslotButtons);
  }

  const bodyText = await page.locator("body").innerText();
  const rows = bodyText
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  const appointmentRows = rows.filter((row) => {
    if (/original .*appointment/i.test(row)) {
      return false;
    }

    if (/select another/i.test(row)) {
      return false;
    }

    return /\b\d{1,2}:\d{2}\s*(AM|PM)\b/i.test(row);
  });

  return buildSlots(appointmentRows);
}

function buildSlots(rows) {
  const slots = [];

  for (const row of rows) {
    const date = parseDateFromText(row);
    if (date) {
      slots.push({ date, raw: row });
    }
  }

  const unique = new Map();
  for (const slot of slots) {
    const key = `${formatDate(slot.date)}|${slot.raw}`;
    unique.set(key, slot);
  }

  return [...unique.values()].sort((a, b) => a.date - b.date);
}

async function searchZip(page, zipCode, config) {
  await ensureZipSearchReady(page);
  await fillZipCode(page, zipCode);
  await clickNext(page);
  await page.waitForLoadState("networkidle").catch(() => {});
  await waitForLoadingToFinish(page).catch(() => {});

  if (config.debugSnapshots) {
    await saveDebugSnapshot(page, `after-zip-${zipCode}`);
  }

  if (await hasZipInput(page)) {
    throw new Error("SSA stayed on the ZIP Code page after Next. The page may still be loading or rejected the click.");
  }

  return extractSlots(page);
}

async function runRound(page, config, notifiedKeys) {
  console.log(`\nStarting round at ${new Date().toLocaleString()}`);

  for (const [index, zipCode] of config.zipCodes.entries()) {
    try {
      console.log(`Checking ZIP ${zipCode}...`);
      const slots = await searchZip(page, zipCode, config);

      if (slots.length === 0) {
        console.log(`ZIP ${zipCode}: no dates found on the result page.`);
        if (config.debugSnapshots) {
          await saveDebugSnapshot(page, `no-dates-${zipCode}`);
        }
      } else {
        console.log(`ZIP ${zipCode}: earliest date found is ${formatDate(slots[0].date)}.`);
      }

      for (const slot of slots) {
        if (compareDateOnly(slot.date, config.currentAppointmentDate) >= 0) {
          continue;
        }

        const key = `${zipCode}|${formatDate(slot.date)}|${slot.raw}`;
        if (!config.notifyOnEveryEarlierResult && notifiedKeys.has(key)) {
          continue;
        }

        notifiedKeys.add(key);
        notify("SSA earlier appointment found", `${zipCode}: ${slot.raw}`);
      }

      if (index < config.zipCodes.length - 1) {
        await returnToZipSearch(page);
      }
    } catch (error) {
      if (isClosedBrowserError(error)) {
        throw error;
      }

      console.error(`ZIP ${zipCode}: ${error.message}`);
    }

    await sleep(config.betweenZipDelayMs);
  }
}

async function main() {
  const config = loadConfig();
  const checkEveryMs = config.checkEveryMinutes * 60 * 1000;
  const profilePath = path.resolve(config.browserProfileDir);
  const notifiedKeys = new Set();

  const context = await chromium.launchPersistentContext(profilePath, {
    headless: config.headless,
    channel: "chrome"
  });

  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(config.startUrl, { waitUntil: "domcontentloaded" });

  console.log("Sign in manually if SSA asks for Login.gov, ID.me, Face ID, passkey, or MFA.");
  console.log("Navigate to the page with the ZIP Code field, then come back here.");
  await pressEnterToContinue("Press Enter when the ZIP Code search page is visible...");
  console.log("Waiting for SSA loading overlay to finish...");
  await ensureZipSearchReady(page);

  console.log(`Starting from ZIP search page: ${page.url()}`);
  console.log(`Checking ${config.zipCodes.length} ZIP code(s) every ${config.checkEveryMinutes} minute(s).`);

  while (true) {
    await runRound(page, config, notifiedKeys);
    console.log(`Round finished. Waiting ${config.checkEveryMinutes} minute(s)...`);
    await sleep(checkEveryMs);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
