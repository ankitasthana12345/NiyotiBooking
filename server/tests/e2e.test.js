// End-to-end tests: real Express app + real MySQL, driven over HTTP.
//
//   npm run test:e2e
//
// Runs against a throwaway database (DB_NAME must end in "_test"); the schema is
// re-applied on every run, so never point this at a real database.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const bcrypt = require("bcrypt");

const root = path.resolve(__dirname, "..", "..");
require("dotenv").config({ path: path.join(root, ".env") });

const TEST_DB = process.env.TEST_DB_NAME || "AppointmentBookingDB_test";
if (!TEST_DB.endsWith("_test")) throw new Error("Refusing to run: test database name must end in _test");
process.env.DB_NAME = TEST_DB;
process.env.DB_DATABASE = TEST_DB;
process.env.SMTP_HOST = ""; // emails are skipped, not sent
process.env.NODE_ENV = "test";

// Capture outgoing email instead of sending it. Must patch before the app (and so emailService)
// is first required, because emailService destructures createTransporter at load time.
const sentMail = [];
require("../config/email").createTransporter = () => ({
  sendMail: async (options) => {
    sentMail.push(options);
    return { messageId: "test" };
  },
});

const ADMIN = { email: "admin@test.local", password: "Test-Password-123" };

let server;
let baseUrl;
let cookie = "";
let pool;

// ---- IST date helpers (slots are IST wall-clock) ---------------------------------
function nowIST() {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return { dateStr: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), seconds: d.getUTCSeconds() };
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dowOf = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay();
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const today = () => nowIST().dateStr;

// Next date (>= from) that falls on the given weekday.
function nextWeekday(from, dow) {
  let d = from;
  while (dowOf(d) !== dow) d = addDays(d, 1);
  return d;
}

// weeklySchedule payload: { [dow]: ["HH:MM", ...] } => 7 entries.
function schedule(byDow) {
  return [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
    dayOfWeek: dow,
    enabled: Boolean(byDow[dow]),
    times: byDow[dow] || [],
  }));
}
const everyDay = (times) => schedule({ 0: times, 1: times, 2: times, 3: times, 4: times, 5: times, 6: times });

// ---- HTTP helpers ------------------------------------------------------------------
async function api(method, url, body, { auth = true } = {}) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: { "Content-Type": "application/json", ...(auth && cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

function generate(startDate, endDate, weeklySchedule, extra = {}) {
  return api("POST", "/api/availability/weekly", { startDate, endDate, durationMinutes: 30, weeklySchedule, ...extra });
}

async function slotRows() {
  const [rows] = await pool._pool.query('SELECT AvailabilityId, AvailableDate, StartTime FROM Availability ORDER BY AvailableDate, StartTime');
  return rows;
}

let personCounter = 0;
function person(overrides = {}) {
  personCounter += 1;
  return {
    title: "Mr.",
    customerName: "Test Person",
    gender: "Male",
    profession: "Teacher / Educator",
    customerEmail: `person${personCounter}@example.com`,
    phoneNumber: `+91 90000${String(personCounter).padStart(5, "0")}`,
    message: "Testing",
    ...overrides,
  };
}

let eventId;
function book(availabilityId, who) {
  return api("POST", "/api/public/bookings", { eventId, availabilityId, ...who }, { auth: false });
}

// Creates n enabled slots on separate future days (inside the 2-week window) and returns their ids.
async function makeSlots(n, { startOffset = 3, time = "10:00" } = {}) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const date = addDays(today(), startOffset + i);
    const res = await generate(date, date, everyDay([time]));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ids.push(res.body.data.availabilityIds[0]);
  }
  return ids;
}

// ---- lifecycle ---------------------------------------------------------------------
before(async () => {
  const schema = spawnSync(process.execPath, [path.join(root, "server", "scripts", "run_schema.js")], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  assert.equal(schema.status, 0, `schema failed: ${schema.stdout}${schema.stderr}`);

  const app = require("../app");
  const { getPool } = require("../config/db");
  pool = await getPool();

  await pool.query(`INSERT INTO "AdminUsers" ("Username", "Email", "PasswordHash", "IsActive") VALUES ($1, $2, $3, TRUE)`, [
    "tester",
    ADMIN.email,
    await bcrypt.hash(ADMIN.password, 4),
  ]);

  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await api("POST", "/api/auth/login", ADMIN, { auth: false });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  cookie = login.headers.get("set-cookie").split(";")[0];

  // No notice period so slots a few days out are bookable.
  const settings = await api("PUT", "/api/availability/settings", { minimumNoticeHours: 24 });
  assert.equal(settings.status, 200);
});

beforeEach(async () => {
  await pool.query('DELETE FROM "Bookings"');
  await pool.query('DELETE FROM "Availability"');
  const events = await api("GET", "/api/public/events", undefined, { auth: false });
  eventId = events.body.data.events[0]?.EventId;
  if (!eventId) {
    // First slot generation creates the default event; do it lazily.
    const date = addDays(today(), 3);
    await generate(date, date, everyDay(["10:00"]));
    await pool.query('DELETE FROM "Availability"');
    eventId = (await api("GET", "/api/public/events", undefined, { auth: false })).body.data.events[0].EventId;
  }
});

after(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  const { closePool } = require("../config/db");
  await closePool();
  // The MySQL session store keeps its own connection open.
  setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
});

// ---- date range rules --------------------------------------------------------------
test("01 a range longer than a year is rejected", async () => {
  const start = addDays(today(), 3);
  const res = await generate(start, addDays(start, 366), everyDay(["10:00"])); // 367 days
  assert.equal(res.status, 400);
  assert.equal(res.body.errorCode, "RANGE_TOO_LARGE");
  assert.equal((await slotRows()).length, 0);
});

test("02 the end date can be any future date: 7 days gives 7 slots, 21 days gives 21", async () => {
  const start = addDays(today(), 3);
  const week = await generate(start, addDays(start, 6), everyDay(["10:00"]));
  assert.equal(week.status, 201, JSON.stringify(week.body));
  assert.equal(week.body.data.slotsGenerated, 7);

  const later = addDays(start, 30);
  const long = await generate(later, addDays(later, 20), everyDay(["10:00"]));
  assert.equal(long.status, 201, JSON.stringify(long.body));
  assert.equal(long.body.data.slotsGenerated, 21);
});

test("02b a multi-week range repeats the chosen weekdays every week (Mon-Fri x 2 weeks = 10)", async () => {
  const monday = nextWeekday(addDays(today(), 40), 1);
  const res = await generate(monday, addDays(monday, 13), schedule({ 1: ["10:00"], 2: ["10:00"], 3: ["10:00"], 4: ["10:00"], 5: ["10:00"] }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.slotsGenerated, 10);
  assert.ok((await slotRows()).every((r) => ![0, 6].includes(dowOf(r.AvailableDate))));
});

test("03 Monday to Friday creates only those 5 dates (no weekend)", async () => {
  const monday = nextWeekday(addDays(today(), 2), 1);
  const friday = addDays(monday, 4);
  const res = await generate(monday, friday, everyDay(["10:00"]));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const rows = await slotRows();
  assert.deepEqual(
    rows.map((r) => r.AvailableDate),
    [0, 1, 2, 3, 4].map((i) => addDays(monday, i))
  );
  assert.ok(rows.every((r) => ![0, 6].includes(dowOf(r.AvailableDate))));
});

test("04 Friday to Wednesday creates Fri..Wed in date order and skips Thursday", async () => {
  const friday = nextWeekday(addDays(today(), 2), 5);
  const wednesday = addDays(friday, 5);
  const res = await generate(friday, wednesday, everyDay(["10:00"]));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const rows = await slotRows();
  assert.deepEqual(
    rows.map((r) => dowOf(r.AvailableDate)),
    [5, 6, 0, 1, 2, 3]
  );
  assert.equal(rows[0].AvailableDate, friday);
  assert.equal(rows[5].AvailableDate, wednesday);
});

test("05 weekdays outside the range are ignored even if enabled in the schedule", async () => {
  const monday = nextWeekday(addDays(today(), 2), 1);
  const wednesday = addDays(monday, 2);
  const res = await generate(monday, wednesday, schedule({ 1: ["09:00"], 2: ["09:00"], 3: ["09:00"], 5: ["09:00"], 6: ["09:00"] }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.slotsGenerated, 3);
  assert.deepEqual((await slotRows()).map((r) => dowOf(r.AvailableDate)), [1, 2, 3]);
});

test("06 single-day range and end-before-start", async () => {
  const day = addDays(today(), 3);
  const one = await generate(day, day, everyDay(["10:00", "11:00"]));
  assert.equal(one.status, 201);
  assert.equal(one.body.data.slotsGenerated, 2);

  const bad = await generate(addDays(day, 2), day, everyDay(["10:00"]));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.errorCode, "INVALID_DATE_RANGE");
});

test("07 regenerating the same slots is rejected as overlap", async () => {
  const day = addDays(today(), 3);
  assert.equal((await generate(day, day, everyDay(["10:00"]))).status, 201);
  const again = await generate(day, day, everyDay(["10:00"]));
  assert.equal(again.status, 409);
  assert.equal(again.body.errorCode, "ALL_SLOTS_SKIPPED");
  assert.equal((await slotRows()).length, 1);
});

// ---- "today" time rules ------------------------------------------------------------
async function withSafeMinute(fn) {
  // Avoid flakiness when the IST minute rolls over mid-test, and near midnight.
  let n = nowIST();
  if (n.seconds >= 50) {
    await new Promise((r) => setTimeout(r, (61 - n.seconds) * 1000));
    n = nowIST();
  }
  if (n.minutes > 24 * 60 - 5) return; // too close to midnight to test today's slots
  return fn(n);
}

test("08 today: the next minute (e.g. 3:00 -> 3:01) is accepted", () =>
  withSafeMinute(async (n) => {
    const res = await generate(n.dateStr, n.dateStr, schedule({ [dowOf(n.dateStr)]: [hhmm(n.minutes + 1)] }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await slotRows())[0].StartTime.slice(0, 5), hhmm(n.minutes + 1));
  }));

test("09 today: the current minute and earlier are rejected", () =>
  withSafeMinute(async (n) => {
    const res = await generate(n.dateStr, n.dateStr, schedule({ [dowOf(n.dateStr)]: [hhmm(n.minutes), hhmm(Math.max(n.minutes - 30, 0))] }));
    assert.equal(res.status, 400);
    assert.equal(res.body.errorCode, "NO_SLOTS_GENERATED");
    assert.equal((await slotRows()).length, 0);
  }));

test("10 today: past times are skipped while later times in the same request are kept", () =>
  withSafeMinute(async (n) => {
    if (n.minutes < 60 || n.minutes > 24 * 60 - 80) return;
    const res = await generate(n.dateStr, n.dateStr, schedule({ [dowOf(n.dateStr)]: [hhmm(n.minutes - 30), hhmm(n.minutes + 1), hhmm(n.minutes + 40)] }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.slotsGenerated, 2);
  }));

test("11 times can be scheduled at one-minute granularity", async () => {
  const day = addDays(today(), 3);
  const res = await generate(day, day, everyDay(["10:01", "10:32", "11:07"]));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.deepEqual((await slotRows()).map((r) => r.StartTime.slice(0, 5)), ["10:01", "10:32", "11:07"]);
});

// ---- two-week public window ----------------------------------------------------------
test("12 public availability shows only the next two weeks", async () => {
  const [near] = await makeSlots(1, { startOffset: 5 });
  const far = addDays(today(), 20);
  assert.equal((await generate(far, far, everyDay(["10:00"]))).status, 201);

  const res = await api("GET", `/api/public/availability/${eventId}`, undefined, { auth: false });
  assert.equal(res.status, 200);
  const dates = res.body.data.availability.map((s) => s.AvailableDate);
  assert.deepEqual(dates, [addDays(today(), 5)]);
  assert.ok(res.body.data.availability.every((s) => s.AvailableDate <= addDays(today(), 14)));
  assert.ok(near);
});

test("13 booking a slot beyond two weeks is refused even by direct API call", async () => {
  const far = addDays(today(), 20);
  const created = await generate(far, far, everyDay(["10:00"]));
  const res = await book(created.body.data.availabilityIds[0], person());
  assert.equal(res.status, 400);
  assert.equal(res.body.errorCode, "OUTSIDE_BOOKING_WINDOW");
});

test("14 the last day of the window (today + 14) is bookable", async () => {
  const edge = addDays(today(), 14);
  const created = await generate(edge, edge, everyDay(["10:00"]));
  const res = await book(created.body.data.availabilityIds[0], person());
  assert.equal(res.status, 201, JSON.stringify(res.body));
});

// ---- one person (same email OR same phone) shares one slot allowance (default 2) ---------------
test("15 same email: two bookings are allowed (2 slots), the third is refused", async () => {
  const [a, b, c] = await makeSlots(3);
  const who = person();
  assert.equal((await book(a, who)).status, 201);
  assert.equal((await book(b, person({ customerEmail: who.customerEmail }))).status, 201); // different phone
  const third = await book(c, person({ customerEmail: who.customerEmail }));
  assert.equal(third.status, 409);
  assert.equal(third.body.errorCode, "SLOTS_EXHAUSTED");
});

test("16 email match ignores upper/lower case", async () => {
  const [a, b, c] = await makeSlots(3);
  assert.equal((await book(a, person({ customerEmail: "Mixed.Case@Example.com" }))).status, 201);
  assert.equal((await book(b, person({ customerEmail: "mixed.case@example.com" }))).status, 201);
  const third = await book(c, person({ customerEmail: "MIXED.CASE@example.com" }));
  assert.equal(third.status, 409);
  assert.equal(third.body.errorCode, "SLOTS_EXHAUSTED");
});

test("17 same phone (even formatted differently) with different emails shares the allowance", async () => {
  const [a, b, c] = await makeSlots(3);
  assert.equal((await book(a, person({ phoneNumber: "+91 98765 43210" }))).status, 201);
  assert.equal((await book(b, person({ phoneNumber: "+91-9876543210" }))).status, 201);
  const third = await book(c, person({ phoneNumber: "+919876543210" }));
  assert.equal(third.status, 409);
  assert.equal(third.body.errorCode, "SLOTS_EXHAUSTED");
});

test("18 different email and different phone can both book", async () => {
  const [a, b] = await makeSlots(2);
  assert.equal((await book(a, person())).status, 201);
  assert.equal((await book(b, person())).status, 201);
});

test("19 after cancelling, the freed slot can be used again", async () => {
  const [a, b, c] = await makeSlots(3);
  const who = person();
  const first = await book(a, who);
  assert.equal(first.status, 201);
  assert.equal((await book(b, who)).status, 201);
  assert.equal((await book(c, who)).status, 409);

  const cancel = await api("POST", `/api/bookings/${first.body.data.booking.BookingId}/cancel`);
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  assert.equal((await book(c, who)).status, 201);
});

test("20 a past booking does not block a new one", async () => {
  const [slot] = await makeSlots(1);
  const who = person();
  const [pastSlot] = await pool.query(
    `INSERT INTO "Availability" ("EventId","AvailableDate","StartTime","EndTime","DurationMinutes","MeetingPlatform","Status")
     VALUES ($1,$2,'10:00:00','10:30:00',30,'Google Meet','ENABLED') RETURNING "AvailabilityId"`,
    [eventId, addDays(today(), -3)]
  ).then((r) => r.rows);
  await pool.query(
    `INSERT INTO "Bookings" ("EventId","AvailabilityId","CustomerName","CustomerEmail","PhoneNumber","BookingDate","StartTime","EndTime","Status","BookingReference")
     VALUES ($1,$2,'Old','${who.customerEmail}','${who.phoneNumber}',$3,'10:00:00','10:30:00','CONFIRMED',UUID())`,
    [eventId, pastSlot.AvailabilityId, addDays(today(), -3)]
  );
  assert.equal((await book(slot, who)).status, 201);
});

// ---- concurrency & basics ---------------------------------------------------------------
test("21 concurrent requests from the same person never exceed the 2-slot allowance", async () => {
  const slots = await makeSlots(4);
  const who = person();
  const results = await Promise.all(slots.map((id) => book(id, who)));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 201, 409, 409], JSON.stringify(results.map((r) => r.body)));
  const [rows] = await pool._pool.query('SELECT COUNT(*) AS n FROM Bookings');
  assert.equal(rows[0].n, 2);
});

test("22 two different people racing for one slot: one wins", async () => {
  const [slot] = await makeSlots(1);
  const results = await Promise.all([book(slot, person()), book(slot, person())]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
});

test("23 a booked slot disappears from the public list", async () => {
  const [a, b] = await makeSlots(2);
  assert.equal((await book(a, person())).status, 201);
  const res = await api("GET", `/api/public/availability/${eventId}`, undefined, { auth: false });
  assert.deepEqual(res.body.data.availability.map((s) => s.AvailabilityId), [b]);
});

test("24 missing phone or email is rejected by validation", async () => {
  const [slot] = await makeSlots(1);
  assert.equal((await book(slot, person({ phoneNumber: "" }))).status, 422);
  assert.equal((await book(slot, person({ customerEmail: "not-an-email" }))).status, 422);
});

test("25 admin endpoints require login", async () => {
  const res = await api("POST", "/api/availability/weekly", { startDate: today() }, { auth: false });
  assert.equal(res.status, 401);
});

// ---- title / gender / profession ----------------------------------------------------------
test("26 title, gender and profession are required and validated", async () => {
  const [slot] = await makeSlots(1);
  for (const bad of [
    { title: "" },
    { title: "Sir" },
    { gender: "" },
    { gender: "Robot" },
    { profession: "" },
    { profession: "x" },
    { profession: "p".repeat(101) },
  ]) {
    const res = await book(slot, person(bad));
    assert.equal(res.status, 422, JSON.stringify(bad));
  }
  assert.equal((await book(slot, person())).status, 201);
});

test("27 all three titles and all four genders are accepted", async () => {
  const slots = await makeSlots(4);
  const titles = ["Mr.", "Mrs.", "Ms."];
  const genders = ["Male", "Female", "Non-binary", "Prefer not to say"];
  for (let i = 0; i < 4; i++) {
    const res = await book(slots[i], person({ title: titles[i % titles.length], gender: genders[i] }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.booking.CustomerTitle, titles[i % titles.length]);
    assert.equal(res.body.data.booking.Gender, genders[i]);
  }
});

test("28 a custom ('Other') profession is stored trimmed and shown to the admin", async () => {
  const [slot] = await makeSlots(1);
  const res = await book(slot, person({ title: "Ms.", gender: "Female", profession: "  Marine Biologist  " }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.booking.Profession, "Marine Biologist");

  const list = await api("GET", "/api/bookings");
  const row = list.body.data.bookings[0];
  assert.equal(row.CustomerTitle, "Ms.");
  assert.equal(row.Gender, "Female");
  assert.equal(row.Profession, "Marine Biologist");
});

test("29 HTML in a custom profession is stored as plain text (escaped on output, not executed)", async () => {
  const [slot] = await makeSlots(1);
  const evil = '<img src=x onerror=alert(1)>';
  const res = await book(slot, person({ profession: evil }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.booking.Profession, evil);
});

// ---- email content ------------------------------------------------------------------------
test("30 admin and customer emails both list every booking detail", async () => {
  const [slot] = await makeSlots(1);
  sentMail.length = 0;
  const who = person({ title: "Mrs.", customerName: "Priya Nair", gender: "Female", profession: "Marine Biologist", customerEmail: "priya.mail@example.com", phoneNumber: "+91 9111122222", message: "Career question" });
  const res = await book(slot, who);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const booking = res.body.data.booking;

  assert.equal(sentMail.length, 2);
  const toCustomer = sentMail.find((m) => m.to === "priya.mail@example.com");
  const toAdmin = sentMail.find((m) => m.to !== "priya.mail@example.com");
  assert.ok(toCustomer && toAdmin);

  for (const mail of [toCustomer, toAdmin]) {
    for (const part of [mail.html, mail.text]) {
      for (const expected of ["Mrs. Priya Nair", "Female", "Marine Biologist", "priya.mail@example.com", "+91 9111122222", "Career question", "30 minutes", "Google Meet", booking.BookingReference]) {
        assert.ok(part.includes(expected), `missing "${expected}" in ${mail.to}`);
      }
    }
  }
});

test("31 user-supplied text is HTML-escaped in emails", async () => {
  const [slot] = await makeSlots(1);
  sentMail.length = 0;
  const evil = "<script>alert(1)</script>";
  const res = await book(slot, person({ profession: evil, message: evil, customerName: "Eve <b>Bold</b>" }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  for (const mail of sentMail) {
    assert.ok(!mail.html.includes("<script>"), "raw <script> must not appear");
    assert.ok(!mail.html.includes("<b>Bold</b>"));
    assert.ok(mail.html.includes("&lt;script&gt;"));
  }
});

// ---- 24-hour notice + 2-week window --------------------------------------------------------
// A slot starting `minutesFromNow` minutes from now (IST), as { date, time }.
function slotAt(minutesFromNow) {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000 + minutesFromNow * 60000);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}

class TooCloseToMidnight extends Error {}

// Some notice tests place slots at "now + N minutes"; between 23:45 and 23:59 IST such a slot cannot
// fit before midnight, so those tests are skipped then (they pass at any other time of day).
function testTimeSensitive(name, fn) {
  return test(name, async () => {
    try {
      await fn();
    } catch (error) {
      if (!(error instanceof TooCloseToMidnight)) throw error;
    }
  });
}

async function makeSlotAt(minutesFromNow) {
  const { date, time } = slotAt(minutesFromNow);
  if (time > "23:44") throw new TooCloseToMidnight();
  // 15-minute slots so a late-evening start (up to 23:44) does not run past midnight.
  const res = await generate(date, date, everyDay([time]), { durationMinutes: 15 });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.availabilityIds[0];
}

async function publicIds() {
  const res = await api("GET", `/api/public/availability/${eventId}`, undefined, { auth: false });
  return res.body.data.availability.map((s) => s.AvailabilityId);
}

testTimeSensitive("32 only slots MORE than 24 hours away are listed (e.g. now 3:00 PM -> tomorrow 3:01 PM onwards)", async () => {
  const soon = await makeSlotAt(60); // in 1 hour
  const justUnder = await makeSlotAt(24 * 60 - 40); // 23h20m (kept apart from the next slot so they cannot overlap)
  const justOver = await makeSlotAt(24 * 60 + 3); // 24h03m
  const nextDay = await makeSlotAt(48 * 60);
  const ids = await publicIds();
  assert.ok(!ids.includes(soon), "1h away must be hidden");
  assert.ok(!ids.includes(justUnder), "23h20m away must be hidden");
  assert.ok(ids.includes(justOver), "24h03m away must be shown");
  assert.ok(ids.includes(nextDay));
});

testTimeSensitive("33 booking a slot inside 24 hours is refused even by direct API call", async () => {
  const soon = await makeSlotAt(6 * 60);
  const res = await book(soon, person());
  assert.equal(res.status, 400);
  assert.equal(res.body.errorCode, "MINIMUM_NOTICE_NOT_MET");
  const ok = await makeSlotAt(24 * 60 + 5);
  assert.equal((await book(ok, person())).status, 201);
});

test("34 notice options: 30 min, 1, 2, 4, 6, 8, 10, 12, 18, 24, 36, 48, 60, 72 hours; anything else is rejected", async () => {
  for (const good of [0.5, 1, 2, 4, 6, 8, 10, 12, 18, 24, 36, 48, 60, 72]) {
    const res = await api("PUT", "/api/availability/settings", { minimumNoticeHours: good });
    assert.equal(res.status, 200, `minimumNoticeHours=${good}`);
    const read = await api("GET", "/api/availability/settings");
    assert.equal(read.body.data.minimumNoticeHours, good, "saved value is returned exactly (30 min stays 0.5)");
  }
  for (const bad of [0, 3, 5, 100, -1, "abc"]) {
    const res = await api("PUT", "/api/availability/settings", { minimumNoticeHours: bad });
    assert.equal(res.status, 422, `minimumNoticeHours=${bad}`);
  }
  await api("PUT", "/api/availability/settings", { minimumNoticeHours: 24 });
});

testTimeSensitive("35 the notice really changes which slots customers see (30 min, 2h, 48h)", async () => {
  try {
    const at20m = await makeSlotAt(20);
    const at45m = await makeSlotAt(105); // 1h45m; spaced apart so 30-min slots never overlap
    const at3h = await makeSlotAt(3 * 60 + 130);
    const at30h = await makeSlotAt(30 * 60);
    const at50h = await makeSlotAt(50 * 60);

    await api("PUT", "/api/availability/settings", { minimumNoticeHours: 0.5 });
    let ids = await publicIds();
    assert.ok(!ids.includes(at20m), "20 min away is inside a 30 min notice");
    assert.ok(ids.includes(at45m) && ids.includes(at3h) && ids.includes(at30h) && ids.includes(at50h));
    assert.equal((await book(at45m, person())).status, 201, "a slot just past 30 min can be booked");

    await api("PUT", "/api/availability/settings", { minimumNoticeHours: 2 });
    ids = await publicIds();
    assert.ok(!ids.includes(at45m), "1h45m away is inside a 2h notice");
    assert.ok(ids.includes(at3h), "5h away is outside a 2h notice");
    assert.ok(ids.includes(at30h));

    await api("PUT", "/api/availability/settings", { minimumNoticeHours: 48 });
    ids = await publicIds();
    assert.ok(!ids.includes(at30h), "30h away is inside a 48h notice");
    assert.ok(ids.includes(at50h));
    assert.equal((await book(at30h, person())).body.errorCode, "MINIMUM_NOTICE_NOT_MET");
  } finally {
    await api("PUT", "/api/availability/settings", { minimumNoticeHours: 24 });
  }
});

testTimeSensitive("36 the public list is limited to 24h..14 days, sorted by date and time", async () => {
  await makeSlotAt(2 * 60);
  const a = await makeSlotAt(5 * 24 * 60);
  const b = await makeSlotAt(2 * 24 * 60);
  await makeSlotAt(17 * 24 * 60);
  const res = await api("GET", `/api/public/availability/${eventId}`, undefined, { auth: false });
  const slots = res.body.data.availability;
  assert.deepEqual(slots.map((s) => s.AvailabilityId), [b, a]);
  assert.ok(slots.every((s) => s.AvailableDate <= addDays(today(), 14)));
});

// ---- per-customer slots (allowance 1-10, default 2) --------------------------------------------
async function insertPastBooking(who, status = "CONFIRMED", daysAgo = 5) {
  const date = addDays(today(), -daysAgo);
  const avail = await pool.query(
    `INSERT INTO "Availability" ("EventId","AvailableDate","StartTime","EndTime","DurationMinutes","MeetingPlatform","Status")
     VALUES ($1,$2,'09:00:00','09:30:00',30,'Google Meet','ENABLED') RETURNING "AvailabilityId"`,
    [eventId, date]
  );
  const ins = await pool.query(
    `INSERT INTO "Bookings" ("EventId","AvailabilityId","CustomerName","CustomerEmail","PhoneNumber","BookingDate","StartTime","EndTime","Status","BookingReference")
     VALUES ($1,$2,'Old Booking',$3,$4,$5,'09:00:00','09:30:00',$6,UUID()) RETURNING "BookingId"`,
    [eventId, avail.rows[0].AvailabilityId, who.customerEmail, who.phoneNumber, date, status]
  );
  return ins.rows[0].BookingId;
}

const setSlots = (bookingId, slots) => api("PUT", `/api/bookings/${bookingId}/slots`, { slots });
const listedBooking = async (bookingId) => (await api("GET", "/api/bookings")).body.data.bookings.find((b) => b.BookingId === bookingId);

test("37 every booking starts with 2 slots and the admin list shows used/allowed", async () => {
  const [slot] = await makeSlots(1);
  const res = await book(slot, person());
  assert.equal(res.status, 201);
  assert.equal(res.body.data.booking.SlotsAllowed, 2);
  const row = await listedBooking(res.body.data.booking.BookingId);
  assert.equal(row.SlotsAllowed, 2);
  assert.equal(row.SlotsUsed, 1);
});

test("38 when all slots are used the customer is told to contact the admin", async () => {
  const [slot] = await makeSlots(1);
  const who = person();
  await insertPastBooking(who, "CONFIRMED", 9);
  await insertPastBooking(who, "CONFIRMED", 5); // 2 of 2 used
  const res = await book(slot, who);
  assert.equal(res.status, 409);
  assert.equal(res.body.errorCode, "SLOTS_EXHAUSTED");
  assert.match(res.body.message, /slots are over.*contact the admin/i);
});

test("39 one used of two: the customer can still book (past bookings count as used)", async () => {
  const [slot] = await makeSlots(1);
  const who = person();
  await insertPastBooking(who);
  assert.equal((await book(slot, who)).status, 201);
});

test("40 admin raises the slots and the customer can book again", async () => {
  const [slot] = await makeSlots(1);
  const who = person();
  const oldId = await insertPastBooking(who);
  await insertPastBooking(who, "CONFIRMED", 8);
  assert.equal((await book(slot, who)).status, 409);

  const saved = await setSlots(oldId, 3);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const res = await book(slot, who);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.booking.SlotsAllowed, 3, "new booking inherits the customer allowance");
});

test("41 admin lowers the slots below what is used: the next booking is refused", async () => {
  const [slot] = await makeSlots(1);
  const who = person();
  const oldId = await insertPastBooking(who);
  assert.equal((await setSlots(oldId, 1)).status, 200);
  const res = await book(slot, who);
  assert.equal(res.status, 409);
  assert.equal(res.body.errorCode, "SLOTS_EXHAUSTED");
});

test("42 the allowance applies to every booking of that customer (same email or same phone)", async () => {
  const who = person({ customerEmail: "same.person@example.com", phoneNumber: "+91 9222233333" });
  const a = await insertPastBooking(who);
  const b = await insertPastBooking({ ...who, customerEmail: "other.mail@example.com" }, "CONFIRMED", 7); // same phone
  const stranger = await insertPastBooking(person(), "CONFIRMED", 11);
  assert.equal((await setSlots(a, 7)).status, 200);
  assert.equal((await listedBooking(a)).SlotsAllowed, 7);
  assert.equal((await listedBooking(b)).SlotsAllowed, 7);
  assert.equal((await listedBooking(stranger)).SlotsAllowed, 2, "other customers are untouched");
});

test("43 cancelled and rejected bookings do not use up a slot", async () => {
  const [slot] = await makeSlots(1);
  const who = person();
  await insertPastBooking(who, "CANCELLED");
  await insertPastBooking(who, "REJECTED", 6);
  await insertPastBooking(who, "CONFIRMED", 7);
  assert.equal((await book(slot, who)).status, 201);
});

test("44 slots must be a whole number from 1 to 10; unknown booking is 404; login required", async () => {
  const [slot] = await makeSlots(1);
  const created = await book(slot, person());
  const id = created.body.data.booking.BookingId;
  for (const bad of [0, 11, -1, 2.5, "abc", null]) {
    assert.equal((await setSlots(id, bad)).status, 422, `slots=${bad}`);
  }
  for (const good of [1, 10, 2]) {
    assert.equal((await setSlots(id, good)).status, 200, `slots=${good}`);
  }
  assert.equal((await setSlots(999999, 3)).status, 404);
  const anon = await api("PUT", `/api/bookings/${id}/slots`, { slots: 3 }, { auth: false });
  assert.equal(anon.status, 401);
});

// ---- email sender / inbox-placement settings ------------------------------------------------------
test("45 mail is sent with a display name, works with no extra settings, and honours the optional ones", async () => {
  const saved = { name: process.env.EMAIL_FROM_NAME, reply: process.env.EMAIL_REPLY_TO, from: process.env.EMAIL_FROM };
  try {
    process.env.EMAIL_FROM = "sender@example.com";
    delete process.env.EMAIL_FROM_NAME;
    delete process.env.EMAIL_REPLY_TO;
    const [a, b, c] = await makeSlots(3);

    sentMail.length = 0;
    assert.equal((await book(a, person())).status, 201);
    assert.ok(sentMail.length === 2);
    for (const m of sentMail) {
      assert.equal(m.from, '"Niyoti Shrivastava" <sender@example.com>');
      assert.equal(m.replyTo, undefined, "no Reply-To unless configured");
    }

    process.env.EMAIL_FROM_NAME = "Coach Niyoti";
    process.env.EMAIL_REPLY_TO = "replies@example.com";
    sentMail.length = 0;
    assert.equal((await book(b, person())).status, 201);
    for (const m of sentMail) {
      assert.equal(m.from, '"Coach Niyoti" <sender@example.com>');
      assert.equal(m.replyTo, "replies@example.com");
    }

    process.env.EMAIL_FROM = "Full Name <own@example.com>"; // already has a display name: untouched
    sentMail.length = 0;
    assert.equal((await book(c, person())).status, 201);
    assert.ok(sentMail.every((m) => m.from === "Full Name <own@example.com>"));
  } finally {
    for (const [k, v] of [["EMAIL_FROM_NAME", saved.name], ["EMAIL_REPLY_TO", saved.reply], ["EMAIL_FROM", saved.from]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("46 customer mails carry the 'drag to Primary' tip; admin mails do not", async () => {
  const [slot] = await makeSlots(1);
  sentMail.length = 0;
  const who = person();
  assert.equal((await book(slot, who)).status, 201);
  const toCustomer = sentMail.find((m) => m.to === who.customerEmail);
  const toAdmin = sentMail.find((m) => m.to !== who.customerEmail);
  assert.match(toCustomer.html, /drag it to your Primary tab/);
  assert.match(toCustomer.text, /drag it to your Primary tab/);
  assert.ok(!toAdmin.html.includes("Primary tab") && !toAdmin.text.includes("Primary tab"));
});

// ---- midnight rule ---------------------------------------------------------------------------------
test("47 a slot must finish before midnight: 11:30 PM + 30 min is rejected, 11:29 PM is the last valid start", async () => {
  const day = addDays(today(), 3);
  const over = await generate(day, day, everyDay(["23:30"])); // would end at 24:00 => EndTime 00:00 < StartTime
  assert.equal(over.status, 400);
  assert.equal(over.body.errorCode, "NO_SLOTS_GENERATED");
  assert.match(over.body.message, /past midnight/i);
  assert.equal((await slotRows()).length, 0);

  const last = await generate(day, day, everyDay(["23:29"]));
  assert.equal(last.status, 201, JSON.stringify(last.body));
  const [rows] = await pool._pool.query("SELECT StartTime, EndTime FROM Availability");
  assert.deepEqual(rows, [{ StartTime: "23:29:00", EndTime: "23:59:00" }]);
});

test("48 mixed times: those before midnight are created, the ones crossing midnight are reported as skipped", async () => {
  const day = addDays(today(), 3);
  const res = await generate(day, day, everyDay(["22:00", "23:45"]));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.slotsGenerated, 1);
  assert.equal(res.body.data.skipped.length, 1);
  assert.match(res.body.data.skipped[0].reason, /midnight/i);
});

// ---- bulk availability selection (Gmail-style bulk actions) ------------------------
test("49 bulk delete removes every slot with no booking history", async () => {
  const ids = await makeSlots(3);
  const res = await api("DELETE", "/api/availability", { ids });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.deleted.slice().sort(), ids.slice().sort());
  assert.equal(res.body.data.disabled.length, 0);
  assert.equal(res.body.data.notFound.length, 0);
  assert.equal((await slotRows()).length, 0);
});

test("50 bulk delete disables (instead of hard-deleting) a slot that has booking history", async () => {
  const [bookedId, freeId] = await makeSlots(2);
  const bookRes = await book(bookedId, person());
  assert.equal(bookRes.status, 201, JSON.stringify(bookRes.body));

  const res = await api("DELETE", "/api/availability", { ids: [bookedId, freeId] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.deleted, [freeId]);
  assert.deepEqual(res.body.data.disabled, [bookedId]);
  assert.match(res.body.message, /disabled instead/);

  const rows = await slotRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].AvailabilityId, bookedId);
});

test("51 bulk delete reports ids that no longer exist, without failing the rest of the batch", async () => {
  const [id] = await makeSlots(1);
  const res = await api("DELETE", "/api/availability", { ids: [id, 999999] });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data.deleted, [id]);
  assert.deepEqual(res.body.data.notFound, [999999]);
});

test("52 bulk status: disabling hides slots from the public list, enabling restores them", async () => {
  const ids = await makeSlots(2);

  const disableRes = await api("PATCH", "/api/availability/status", { ids, isDisabled: true });
  assert.equal(disableRes.status, 200, JSON.stringify(disableRes.body));
  assert.equal(disableRes.body.data.updated, 2);

  const publicAfterDisable = await api("GET", `/api/public/availability/${eventId}`, undefined, { auth: false });
  assert.deepEqual(publicAfterDisable.body.data.availability, []);

  const enableRes = await api("PATCH", "/api/availability/status", { ids, isDisabled: false });
  assert.equal(enableRes.status, 200, JSON.stringify(enableRes.body));
  assert.equal(enableRes.body.data.updated, 2);

  const publicAfterEnable = await api("GET", `/api/public/availability/${eventId}`, undefined, { auth: false });
  assert.deepEqual(
    publicAfterEnable.body.data.availability.map((s) => s.AvailabilityId).sort(),
    ids.slice().sort()
  );
});

test("53 bulk availability endpoints require login and validate the ids array", async () => {
  const [id] = await makeSlots(1);

  const noAuthDelete = await api("DELETE", "/api/availability", { ids: [id] }, { auth: false });
  assert.equal(noAuthDelete.status, 401);

  const noAuthStatus = await api("PATCH", "/api/availability/status", { ids: [id], isDisabled: true }, { auth: false });
  assert.equal(noAuthStatus.status, 401);

  const emptyIds = await api("DELETE", "/api/availability", { ids: [] });
  assert.equal(emptyIds.status, 422);

  const badIds = await api("PATCH", "/api/availability/status", { ids: ["not-a-number"], isDisabled: true });
  assert.equal(badIds.status, 422);
});

// ---- starring a booking -------------------------------------------------------------
test("54 star toggle marks a booking starred, persists, and can be unstarred again", async () => {
  const [slot] = await makeSlots(1);
  const created = await book(slot, person());
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const bookingId = created.body.data.booking.BookingId;

  const starRes = await api("PATCH", `/api/bookings/${bookingId}/star`, { isStarred: true });
  assert.equal(starRes.status, 200, JSON.stringify(starRes.body));
  assert.equal(starRes.body.data.isStarred, true);
  assert.equal(Boolean((await listedBooking(bookingId)).IsStarred), true);

  const unstarRes = await api("PATCH", `/api/bookings/${bookingId}/star`, { isStarred: false });
  assert.equal(unstarRes.status, 200, JSON.stringify(unstarRes.body));
  assert.equal(Boolean((await listedBooking(bookingId)).IsStarred), false);
});

test("55 starredOnly filter returns only starred bookings", async () => {
  const [slot1, slot2] = await makeSlots(2);
  const b1 = await book(slot1, person());
  const b2 = await book(slot2, person());
  assert.equal(b1.status, 201, JSON.stringify(b1.body));
  assert.equal(b2.status, 201, JSON.stringify(b2.body));

  await api("PATCH", `/api/bookings/${b1.body.data.booking.BookingId}/star`, { isStarred: true });

  const res = await api("GET", "/api/bookings?starredOnly=true");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.data.bookings.length > 0);
  assert.ok(res.body.data.bookings.every((b) => Boolean(b.IsStarred)));
  assert.ok(res.body.data.bookings.some((b) => b.BookingId === b1.body.data.booking.BookingId));
  assert.ok(!res.body.data.bookings.some((b) => b.BookingId === b2.body.data.booking.BookingId));
});

test("56 star endpoint 404s for an unknown booking and requires login", async () => {
  const notFound = await api("PATCH", "/api/bookings/999999/star", { isStarred: true });
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.errorCode, "BOOKING_NOT_FOUND");

  const noAuth = await api("PATCH", "/api/bookings/1/star", { isStarred: true }, { auth: false });
  assert.equal(noAuth.status, 401);
});
