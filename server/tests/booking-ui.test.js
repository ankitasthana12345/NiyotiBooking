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
  await adminApi("PUT", "/api/availability/settings", { minimumNoticeHours: 0 }, cookie);

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
    assert.deepEqual(await page.$$eval("#title option", (o) => o.map((x) => x.value)), ["", "Mr.", "Mrs.", "Ms.", "Miss"]);
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

test("UI-6 the same person booking again is refused with a visible message", async () => {
  const { context, page } = await newBookingPage();
  try {
    await fillForm(page, {
      title: "Mr.", name: "Rohan Mehta", gender: "Male", profession: "Student",
      email: "rohan.ui@example.com", phone: "9000000099", dateIndex: 1,
    });
    await page.click('button[type="submit"]');
    await page.waitForSelector("#bookingFeedback .alert-danger");
    assert.match(await page.textContent("#bookingFeedback"), /already have an upcoming appointment/i);
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
