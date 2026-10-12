// Browser automation for the public booking form and the admin bookings table.
//
//   npm run test:ui
//
// Drives a real browser (Microsoft Edge or Chrome, via playwright-core - no browser download
// needed) against the app running on the throwaway *_test database. Set HEADED=1 to watch it.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const bcrypt = require("bcrypt");
const { chromium } = require("playwright-core");

const root = path.resolve(__dirname, "..", "..");
require("dotenv").config({ path: path.join(root, ".env") });

const TEST_DB = process.env.TEST_DB_NAME || "AppointmentBookingDB_test";
if (!TEST_DB.endsWith("_test")) throw new Error("Refusing to run: test database name must end in _test");
process.env.DB_NAME = TEST_DB;
process.env.DB_DATABASE = TEST_DB;
process.env.SMTP_HOST = "";
process.env.NODE_ENV = "test";

const ADMIN = { email: "admin@test.local", password: "Test-Password-123" };
const XSS = "<img src=x onerror=window.__pwned=1>";

let server, baseUrl, browser, pool;

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

async function adminApi(method, url, body, cookie) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

// POST /api/auth/login is rate-limited (10 per 15 min, server/app.js's loginLimiter), and this
// file already logs in as admin several times over (before(), UI-7, UI-8, UI-10, UI-11, ...).
// The UI-12..UI-16 tests below share ONE authenticated browser context/page instead of logging
// in fresh each time, so the whole file stays comfortably under that budget.
let sharedAdminContext;
let sharedAdminPage;
async function adminPage() {
  if (!sharedAdminPage) {
    sharedAdminContext = await browser.newContext();
    sharedAdminPage = await sharedAdminContext.newPage();
    await sharedAdminPage.goto(`${baseUrl}/admin-login.html`);
    await sharedAdminPage.fill("#email", ADMIN.email);
    await sharedAdminPage.fill("#password", ADMIN.password);
    await sharedAdminPage.click('button[type="submit"]');
    await sharedAdminPage.waitForURL("**/admin-dashboard.html");
  }
  return sharedAdminPage;
}

// Creates one single-day slot per date (all at `time`, on days that don't collide with the
// 5 slots seeded in before()), returning their AvailabilityIds. Uses the page's own cookie
// jar (page.request) rather than a hand-extracted Cookie header, and doesn't consume a
// separate login attempt.
async function seedSlotsViaPage(page, dates, time = "11:00") {
  const ids = [];
  for (const date of dates) {
    const weeklySchedule = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, enabled: true, times: [time] }));
    const res = await page.request.post(`${baseUrl}/api/availability/weekly`, {
      data: { startDate: date, endDate: date, durationMinutes: 30, weeklySchedule },
    });
    const body = await res.json();
    assert.equal(res.status(), 201, JSON.stringify(body));
    ids.push(...body.data.availabilityIds);
  }
  return ids;
}

after(async () => {
  await sharedAdminContext?.close();
});

before(async () => {
  const schema = spawnSync(process.execPath, [path.join(root, "server", "scripts", "run_schema.js")], { cwd: root, env: process.env, encoding: "utf8" });
  assert.equal(schema.status, 0, `schema failed: ${schema.stdout}${schema.stderr}`);

  const app = require("../app");
  pool = await require("../config/db").getPool();
  await pool.query(`INSERT INTO "AdminUsers" ("Username", "Email", "PasswordHash", "IsActive") VALUES ($1, $2, $3, TRUE)`, [
    "tester",
    ADMIN.email,
    await bcrypt.hash(ADMIN.password, 4),
  ]);
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await adminApi("POST", "/api/auth/login", ADMIN);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await adminApi("PUT", "/api/availability/settings", { minimumNoticeHours: 24 }, cookie);

  // 5 single-day slots (days +3..+7) so each scenario has its own slot.
  for (let i = 3; i <= 7; i++) {
    const date = addDays(todayIST(), i);
    const weeklySchedule = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, enabled: true, times: ["10:00"] }));
    const res = await adminApi("POST", "/api/availability/weekly", { startDate: date, endDate: date, durationMinutes: 30, weeklySchedule }, cookie);
    assert.equal(res.status, 201);
  }

  browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || "msedge", headless: !process.env.HEADED });
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await require("../config/db").closePool();
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
});

async function newBookingPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  // The success flow opens the WhatsApp community in a new tab - close it.
  context.on("page", (p) => p !== page && p.close().catch(() => {}));
  await page.goto(`${baseUrl}/booking.html`);
  await page.waitForFunction(() => document.querySelectorAll("#availableDateSelect option").length > 1);
  return { context, page };
}

async function fillForm(page, { title, name, gender, profession, other, email, phone, dateIndex = 1 }) {
  await page.selectOption("#title", title);
  await page.fill("#customerName", name);
  await page.selectOption("#gender", gender);
  await page.selectOption("#profession", profession);
  if (other !== undefined) await page.fill("#professionOther", other);
  await page.fill("#customerEmail", email);
  await page.fill("#phoneNumber", phone);
  await page.selectOption("#availableDateSelect", { index: dateIndex });
  await page.selectOption("#availableTimeSelect", { index: 1 });
  await page.fill("#message", "UI automation test");
}

test("UI-1 form shows Title, Gender and a Profession list ending in 'Other'", async () => {
  const { context, page } = await newBookingPage();
  try {
    assert.deepEqual(await page.$$eval("#title option", (o) => o.map((x) => x.value)), ["", "Mr.", "Mrs.", "Ms."]);
    assert.deepEqual(await page.$$eval("#gender option", (o) => o.map((x) => x.value)), ["", "Male", "Female", "Non-binary", "Prefer not to say"]);
    const professions = await page.$$eval("#profession option", (o) => o.map((x) => x.value));
    assert.ok(professions.length > 30, "profession list should be long");
    assert.equal(professions[0], "");
    assert.equal(professions[professions.length - 1], "Other");
    assert.ok(await page.locator("#professionOther").isHidden(), "free-text box hidden until 'Other' is chosen");
  } finally {
    await context.close();
  }
});

test("UI-2 choosing 'Other' reveals a required text box; choosing a listed profession hides it again", async () => {
  const { context, page } = await newBookingPage();
  try {
    await page.selectOption("#profession", "Other");
    assert.ok(await page.locator("#professionOther").isVisible());
    assert.equal(await page.locator("#professionOther").getAttribute("required"), "");
    await page.fill("#professionOther", "typed text");
    await page.selectOption("#profession", "Student");
    assert.ok(await page.locator("#professionOther").isHidden());
    assert.equal(await page.inputValue("#professionOther"), "", "hidden text is cleared");
  } finally {
    await context.close();
  }
});

test("UI-3 submit is blocked while Title / Gender / Profession (or the 'Other' text) is empty", async () => {
  const { context, page } = await newBookingPage();
  try {
    let requests = 0;
    page.on("request", (r) => r.url().includes("/api/public/bookings") && r.method() === "POST" && requests++);

    await page.fill("#customerName", "No Title");
    await page.fill("#customerEmail", "blocked@example.com");
    await page.fill("#phoneNumber", "9000000001");
    await page.selectOption("#availableDateSelect", { index: 1 });
    await page.selectOption("#availableTimeSelect", { index: 1 });
    await page.fill("#message", "x");
    await page.click('button[type="submit"]');
    assert.equal(await page.evaluate(() => document.querySelector("#title").validity.valueMissing), true);

    await page.selectOption("#title", "Mr.");
    await page.selectOption("#gender", "Male");
    await page.selectOption("#profession", "Other");
    await page.click('button[type="submit"]');
    assert.equal(await page.evaluate(() => document.querySelector("#professionOther").validity.valueMissing), true);
    assert.equal(requests, 0, "no booking request should be sent");
  } finally {
    await context.close();
  }
});

test("UI-4 booking with a typed 'Other' profession succeeds and is stored", async () => {
  const { context, page } = await newBookingPage();
  try {
    await fillForm(page, {
      title: "Ms.", name: "Asha Verma", gender: "Female", profession: "Other", other: "Marine Biologist",
      email: "asha.ui@example.com", phone: "9000000002",
    });
    await page.click('button[type="submit"]');
    await page.waitForSelector("#bookingFeedback .alert-success");
    assert.match(await page.textContent("#bookingFeedback"), /booked successfully/);

    const [rows] = await pool._pool.query("SELECT Title, Gender, Profession, CustomerName FROM Bookings WHERE CustomerEmail = 'asha.ui@example.com'");
    assert.deepEqual(rows, [{ Title: "Ms.", Gender: "Female", Profession: "Marine Biologist", CustomerName: "Asha Verma" }]);
    assert.ok(await page.locator("#professionOther").isHidden(), "form is reset after success");
  } finally {
    await context.close();
  }
});

test("UI-5 booking with a profession from the list succeeds", async () => {
  const { context, page } = await newBookingPage();
  try {
    await fillForm(page, {
      title: "Mr.", name: "Rohan Mehta", gender: "Male", profession: "Software Engineer / IT Professional",
      email: "rohan.ui@example.com", phone: "9000000003", dateIndex: 1,
    });
    await page.click('button[type="submit"]');
    await page.waitForSelector("#bookingFeedback .alert-success");
    const [rows] = await pool._pool.query("SELECT Title, Gender, Profession FROM Bookings WHERE CustomerEmail = 'rohan.ui@example.com'");
    assert.deepEqual(rows, [{ Title: "Mr.", Gender: "Male", Profession: "Software Engineer / IT Professional" }]);
  } finally {
    await context.close();
  }
});

test("UI-6 the same person can book a second slot (default allowance is 2)", async () => {
  const { context, page } = await newBookingPage();
  try {
    await fillForm(page, {
      title: "Mr.", name: "Rohan Mehta", gender: "Male", profession: "Student",
      email: "rohan.ui@example.com", phone: "9000000099", dateIndex: 1,
    });
    await page.click('button[type="submit"]');
    await page.waitForSelector("#bookingFeedback .alert-success");
  } finally {
    await context.close();
  }
});

test("UI-7 admin bookings table shows title+name, gender and profession, and escapes HTML", async () => {
  // Book with an HTML-looking custom profession, then look at it as the admin.
  const { context: c1, page: p1 } = await newBookingPage();
  try {
    await fillForm(p1, {
      title: "Mrs.", name: "Priya Nair", gender: "Female", profession: "Other", other: XSS,
      email: "priya.ui@example.com", phone: "9000000004", dateIndex: 1,
    });
    await p1.click('button[type="submit"]');
    await p1.waitForSelector("#bookingFeedback .alert-success");
  } finally {
    await c1.close();
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  let dialogs = 0;
  page.on("dialog", (d) => (dialogs++, d.dismiss()));
  try {
    await page.goto(`${baseUrl}/admin-login.html`);
    await page.fill("#email", ADMIN.email);
    await page.fill("#password", ADMIN.password);
    await page.click('button[type="submit"]');
    await page.waitForURL("**/admin-dashboard.html");
    await page.goto(`${baseUrl}/admin-bookings.html`);
    await page.waitForSelector("#bookingsBody tr");

    const headers = await page.$$eval("thead th", (t) => t.map((x) => x.textContent.trim()));
    assert.ok(headers.includes("Gender") && headers.includes("Profession"), headers.join(","));

    const rowText = await page.locator("#bookingsBody tr", { hasText: "Priya Nair" }).first().innerText();
    assert.match(rowText, /Mrs\. Priya Nair/);
    assert.match(rowText, /Female/);
    assert.ok(rowText.includes(XSS), "profession is shown literally as text");
    assert.equal(await page.evaluate(() => window.__pwned), undefined, "injected HTML must not execute");
    assert.equal(await page.locator("#bookingsBody img").count(), 0);
    assert.equal(dialogs, 0);
  } finally {
    await context.close();
  }
});

async function adminBookingsPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${baseUrl}/admin-login.html`);
  await page.fill("#email", ADMIN.email);
  await page.fill("#password", ADMIN.password);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/admin-dashboard.html");
  await page.goto(`${baseUrl}/admin-bookings.html`);
  await page.waitForSelector("#bookingsBody tr");
  return { context, page };
}

test("UI-8 admin bookings table has a Slots column (1-10, default 2) that can be changed and saved", async () => {
  const { context, page } = await adminBookingsPage();
  try {
    const headers = await page.$$eval("thead th", (t) => t.map((x) => x.textContent.trim()));
    assert.ok(headers.includes("Slots"), headers.join(","));

    const row = page.locator("#bookingsBody tr", { hasText: "Rohan Mehta" }).first();
    const select = row.locator("select[id^='slots-select-']");
    assert.deepEqual(await select.locator("option").evaluateAll((o) => o.map((x) => x.value)), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    assert.equal(await select.inputValue(), "2", "default is 2 slots");
    assert.match(await row.innerText(), /2 of 2 used/);

    await select.selectOption("1");
    await row.locator("button[data-action='save-slots']").click();
    await page.waitForSelector("#feedback .alert-success");
    assert.match(await page.textContent("#feedback"), /Slots saved: 1/);

    // Persisted: reload and check again.
    await page.reload();
    await page.waitForSelector("#bookingsBody tr");
    const again = page.locator("#bookingsBody tr", { hasText: "Rohan Mehta" }).first();
    assert.equal(await again.locator("select[id^='slots-select-']").inputValue(), "1");
    assert.match(await again.innerText(), /2 of 1 used[\s\S]*slots over/);
  } finally {
    await context.close();
  }
});

test("UI-9 a customer whose slots are over sees 'contact the admin' on the booking page", async () => {
  const { context, page } = await newBookingPage();
  try {
    await fillForm(page, {
      title: "Mr.", name: "Rohan Mehta", gender: "Male", profession: "Student",
      email: "rohan.ui@example.com", phone: "9000000077", dateIndex: 1,
    });
    await page.click('button[type="submit"]');
    await page.waitForSelector("#bookingFeedback .alert-danger");
    assert.match(await page.textContent("#bookingFeedback"), /slots are over[\s\S]*contact the admin/i);
  } finally {
    await context.close();
  }
});

// ---- admin "Generate Slots": today's start time is always in the future ---------------------------------
test("UI-10 on today's date the start time defaults to the next minute and past times cannot be chosen", async () => {
  // The browser clock is fixed at 2:37:20 PM IST today, so the test gives the same result at any real time.
  const istDate = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  const n = { minutes: 14 * 60 + 37 };

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.clock.install({ time: new Date(`${istDate}T09:07:20Z`) }); // 14:37:20 IST
  try {
    await page.goto(`${baseUrl}/admin-login.html`);
    await page.fill("#email", ADMIN.email);
    await page.fill("#password", ADMIN.password);
    await page.click('button[type="submit"]');
    await page.waitForURL("**/admin-dashboard.html");
    await page.goto(`${baseUrl}/admin-availability.html`);

    const today = await page.inputValue("#rangeStartDate");
    const end = new Date(`${today}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 2);
    await page.fill("#rangeEndDate", end.toISOString().slice(0, 10));
    await page.dispatchEvent("#rangeEndDate", "change");

    const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();
    const row = page.locator(`#day-times-${todayDow} .time-row`).first();
    const readRow = async () => {
      const h = Number(await row.locator(".time-hour").inputValue());
      const m = Number(await row.locator(".time-minute").inputValue());
      const p = await row.locator(".time-period").inputValue();
      return (h % 12) * 60 + (p === "PM" ? 720 : 0) + m;
    };

    // default = current minute + 1
    const want = n.minutes + 1;
    const got = await readRow();
    assert.ok(got === want || got === want + 1, `default start ${got} should be now+1 (${want})`);

    // every hour / period option that lies in the past is disabled
    const periodOptions = await row.locator(".time-period option").evaluateAll((o) => o.map((x) => [x.value, x.disabled]));
    if (n.minutes >= 720) assert.deepEqual(periodOptions.find((o) => o[0] === "AM"), ["AM", true]);
    const nowHour24 = Math.floor(n.minutes / 60);
    const period = await row.locator(".time-period").inputValue();
    const hourStates = await row.locator(".time-hour option").evaluateAll((o) => o.map((x) => [Number(x.value), x.disabled]));
    for (const [h12, disabled] of hourStates) {
      const h24 = (h12 % 12) + (period === "PM" ? 12 : 0);
      assert.equal(disabled, h24 < nowHour24, `hour ${h12} ${period}`);
    }

    // forcing an earlier time is snapped back to the earliest allowed time
    await row.locator(".time-hour").evaluate((el) => { el.disabled = false; });
    await row.locator(".time-hour").evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }, "12");
    await row.locator(".time-period").evaluate((el) => { el.value = "AM"; el.dispatchEvent(new Event("change", { bubbles: true })); });
    await row.locator(".time-minute").evaluate((el) => { el.value = "0"; el.dispatchEvent(new Event("change", { bubbles: true })); });
    assert.ok((await readRow()) >= n.minutes + 1, "a past time is never kept");

    // tomorrow's weekday keeps the normal 9:00 AM default
    const tomorrowRow = page.locator(`#day-times-${(todayDow + 1) % 7} .time-row`).first();
    assert.equal(await tomorrowRow.locator(".time-hour").inputValue(), "9");
    assert.equal(await tomorrowRow.locator(".time-period").inputValue(), "AM");
  } finally {
    await context.close();
  }
});

test("UI-11 a start time that would run past midnight is flagged and the form refuses to submit it", async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/admin-login.html`);
    await page.fill("#email", ADMIN.email);
    await page.fill("#password", ADMIN.password);
    await page.click('button[type="submit"]');
    await page.waitForURL("**/admin-dashboard.html");
    await page.goto(`${baseUrl}/admin-availability.html`);

    const start = new Date(Date.now() + 5.5 * 3600 * 1000 + 3 * 86400000).toISOString().slice(0, 10);
    await page.fill("#rangeStartDate", start);
    await page.dispatchEvent("#rangeStartDate", "change");
    await page.fill("#rangeEndDate", start);
    await page.dispatchEvent("#rangeEndDate", "change");

    const dow = new Date(`${start}T00:00:00Z`).getUTCDay();
    const row = page.locator(`#day-times-${dow} .time-row`).first();
    for (const [sel, val] of [[".time-hour", "11"], [".time-minute", "45"], [".time-period", "PM"]]) {
      await row.locator(sel).evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }, val);
    }
    assert.equal(await row.locator(".time-end").inputValue(), "Past midnight");

    let posted = 0;
    page.on("request", (r) => r.url().includes("/api/availability/weekly") && r.method() === "POST" && posted++);
    await page.click('#availabilityForm button[type="submit"]');
    await page.waitForSelector("#feedback .alert-danger");
    assert.match(await page.textContent("#feedback"), /past midnight/i);
    assert.equal(posted, 0, "nothing is sent to the server");

    // a valid time clears the flag
    await row.locator(".time-hour").evaluate((el) => { el.value = "10"; el.dispatchEvent(new Event("change", { bubbles: true })); });
    assert.notEqual(await row.locator(".time-end").inputValue(), "Past midnight");
  } finally {
    await context.close();
  }
});

// ---- admin "Slots" table: Gmail-style bulk selection ---------------------------------
// UI-12..UI-16 all reuse the one shared admin page/session (see adminPage() above) instead
// of logging in per test, to stay well under the login rate limit.
test("UI-12 select-all checks every slot (and goes indeterminate for a partial selection)", async () => {
  const page = await adminPage();
  const ids = await seedSlotsViaPage(page, [addDays(todayIST(), 9), addDays(todayIST(), 10), addDays(todayIST(), 11)], "09:00");

  await page.goto(`${baseUrl}/admin-availability.html`);
  await page.waitForSelector(`.slot-checkbox[data-id="${ids[0]}"]`);
  const rowCount = await page.locator("#availabilityBody .slot-checkbox").count();
  assert.ok(rowCount >= 3, "at least the 3 seeded slots are listed");

  assert.ok(await page.locator("#bulkToolbar").isHidden(), "toolbar hidden with nothing selected");

  await page.locator(`.slot-checkbox[data-id="${ids[0]}"]`).check();
  assert.ok(await page.locator("#bulkToolbar").isVisible());
  assert.match(await page.textContent("#bulkSelectedCount"), /1 selected/);
  assert.equal(await page.locator("#selectAllSlots").evaluate((el) => el.indeterminate), true);

  await page.locator("#selectAllSlots").check();
  assert.equal(await page.locator("#availabilityBody .slot-checkbox:checked").count(), rowCount);
  assert.match(await page.textContent("#bulkSelectedCount"), new RegExp(`${rowCount} selected`));
  assert.equal(await page.locator("#selectAllSlots").evaluate((el) => el.indeterminate), false);

  await page.locator("#selectAllSlots").uncheck();
  assert.equal(await page.locator("#availabilityBody .slot-checkbox:checked").count(), 0);
  assert.ok(await page.locator("#bulkToolbar").isHidden());
});

test("UI-13 bulk delete removes the selected slots after a confirm dialog", async () => {
  const page = await adminPage();
  const ids = await seedSlotsViaPage(page, [addDays(todayIST(), 12), addDays(todayIST(), 13)], "09:30");

  await page.goto(`${baseUrl}/admin-availability.html`);
  await page.waitForSelector(`.slot-checkbox[data-id="${ids[0]}"]`);
  let dialogMessage = "";
  page.once("dialog", (d) => {
    dialogMessage = d.message();
    d.accept();
  });

  await page.locator(`.slot-checkbox[data-id="${ids[0]}"]`).check();
  await page.locator(`.slot-checkbox[data-id="${ids[1]}"]`).check();
  await page.click("#bulkDeleteBtn");

  await page.waitForSelector("#feedback .alert-success");
  assert.match(dialogMessage, /delete 2 slot/i);
  assert.match(dialogMessage, /cannot be undone/i);
  for (const id of ids) {
    assert.equal(await page.locator(`.slot-checkbox[data-id="${id}"]`).count(), 0, `slot ${id} removed from the table`);
  }
  assert.ok(await page.locator("#bulkToolbar").isHidden(), "selection cleared after the bulk action");
});

test("UI-14 bulk disable greys out the row with a Disabled badge, hides it from the public page, and Undo restores it", async () => {
  const page = await adminPage();
  const date = addDays(todayIST(), 9);
  const [slotId] = await seedSlotsViaPage(page, [date], "16:00");
  const eventsRes = await page.request.get(`${baseUrl}/api/public/events`);
  const eventId = (await eventsRes.json()).data.events[0].EventId;

  await page.goto(`${baseUrl}/admin-availability.html`);
  await page.waitForSelector(`.slot-checkbox[data-id="${slotId}"]`);
  await page.locator(`.slot-checkbox[data-id="${slotId}"]`).check();

  let dialogFired = false;
  page.once("dialog", () => (dialogFired = true));
  await page.click("#bulkDisableBtn");
  await page.waitForSelector(`tr:has(.slot-checkbox[data-id="${slotId}"]) .badge:has-text("Disabled")`);
  assert.equal(dialogFired, false, "disable needs no confirmation");

  const row = page.locator(`tr:has(.slot-checkbox[data-id="${slotId}"])`);
  assert.ok((await row.getAttribute("class") || "").includes("table-row-disabled"));

  await page.waitForSelector("#toastContainer .admin-toast");
  assert.match(await page.textContent("#toastContainer"), /1 slot disabled/);

  const publicListed = async () => {
    const res = await fetch(`${baseUrl}/api/public/availability/${eventId}`);
    const body = await res.json();
    return body.data.availability.some((s) => s.AvailabilityId === slotId);
  };
  assert.equal(await publicListed(), false, "disabled slots are hidden from the public booking page");

  await page.click("#toastUndoBtn");
  await page.waitForFunction(
    (id) => !document.querySelector(`tr:has(.slot-checkbox[data-id="${id}"])`)?.textContent.includes("Disabled"),
    slotId
  );
  assert.equal(await publicListed(), true, "Undo re-enables the slot");
});

// ---- admin bookings: star ------------------------------------------------------------
test("UI-15 star toggle updates instantly and persists after reload", async () => {
  const page = await adminPage();
  await page.goto(`${baseUrl}/admin-bookings.html`);
  await page.waitForSelector("#bookingsBody tr");

  const row = page.locator("#bookingsBody tr", { hasText: "Rohan Mehta" }).first();
  const starBtn = row.locator("button[data-action='toggle-star']");
  assert.equal(await starBtn.getAttribute("aria-pressed"), "false", "starts unstarred");
  assert.equal(await starBtn.textContent(), "☆");

  const [response] = await Promise.all([page.waitForResponse((r) => r.url().includes("/star") && r.request().method() === "PATCH"), starBtn.click()]);
  assert.equal(response.status(), 200);
  assert.equal(await starBtn.getAttribute("aria-pressed"), "true", "flips instantly (optimistic update)");
  assert.equal(await starBtn.textContent(), "★");
  assert.ok((await starBtn.getAttribute("class") || "").includes("starred"));

  await page.reload();
  await page.waitForSelector("#bookingsBody tr");
  const again = page.locator("#bookingsBody tr", { hasText: "Rohan Mehta" }).first();
  assert.equal(await again.locator("button[data-action='toggle-star']").getAttribute("aria-pressed"), "true", "starred state survives reload");
});

test("UI-16 'Starred only' filters the table down to starred bookings", async () => {
  const page = await adminPage();
  await page.goto(`${baseUrl}/admin-bookings.html`);
  await page.waitForSelector("#bookingsBody tr");

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("starredOnly=true")),
    page.check("#starredOnlyFilter"),
  ]);
  assert.equal(response.status(), 200);

  const stars = await page.locator("#bookingsBody button[data-action='toggle-star']").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-pressed")));
  assert.ok(stars.length > 0, "the booking starred in UI-15 is shown");
  assert.ok(stars.every((s) => s === "true"), "every visible row is starred");

  await page.uncheck("#starredOnlyFilter");
});
