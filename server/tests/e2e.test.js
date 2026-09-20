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
  const settings = await api("PUT", "/api/availability/settings", { minimumNoticeHours: 0 });
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
test("01 range longer than 7 days is rejected", async () => {
  const start = addDays(today(), 3);
  const res = await generate(start, addDays(start, 7), everyDay(["10:00"])); // 8 days
  assert.equal(res.status, 400);
  assert.equal(res.body.errorCode, "RANGE_TOO_LARGE");
  assert.equal((await slotRows()).length, 0);
});

test("02 exactly 7 days is accepted and yields one slot per date", async () => {
  const start = addDays(today(), 3);
  const res = await generate(start, addDays(start, 6), everyDay(["10:00"]));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.slotsGenerated, 7);
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

// ---- one person = one upcoming booking (same email OR same phone) -----------------------
test("15 same email cannot hold two upcoming bookings", async () => {
  const [a, b] = await makeSlots(2);
  const who = person();
  assert.equal((await book(a, who)).status, 201);
  const second = await book(b, person({ customerEmail: who.customerEmail })); // different phone
  assert.equal(second.status, 409);
  assert.equal(second.body.errorCode, "DUPLICATE_BOOKING");
});

test("16 email match ignores case and surrounding whitespace", async () => {
  const [a, b] = await makeSlots(2);
  const who = person({ customerEmail: "Mixed.Case@Example.com" });
  assert.equal((await book(a, who)).status, 201);
  const second = await book(b, person({ customerEmail: "mixed.case@example.com" }));
  assert.equal(second.status, 409);
  assert.equal(second.body.errorCode, "DUPLICATE_BOOKING");
});

test("17 same phone (even formatted differently) with a different email is refused", async () => {
  const [a, b] = await makeSlots(2);
  assert.equal((await book(a, person({ phoneNumber: "+91 98765 43210" }))).status, 201);
  const second = await book(b, person({ phoneNumber: "+91-9876543210" }));
  assert.equal(second.status, 409);
  assert.equal(second.body.errorCode, "DUPLICATE_BOOKING");
});

test("18 different email and different phone can both book", async () => {
  const [a, b] = await makeSlots(2);
  assert.equal((await book(a, person())).status, 201);
  assert.equal((await book(b, person())).status, 201);
});

test("19 after cancelling, the same person can book again", async () => {
  const [a, b] = await makeSlots(2);
  const who = person();
  const first = await book(a, who);
  assert.equal(first.status, 201);
  assert.equal((await book(b, who)).status, 409);

  const cancel = await api("POST", `/api/bookings/${first.body.data.booking.BookingId}/cancel`);
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  assert.equal((await book(b, who)).status, 201);
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
test("21 concurrent requests from the same person book exactly one slot", async () => {
  const slots = await makeSlots(4);
  const who = person();
  const results = await Promise.all(slots.map((id) => book(id, who)));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409, 409], JSON.stringify(results.map((r) => r.body)));
  const [rows] = await pool._pool.query('SELECT COUNT(*) AS n FROM Bookings');
  assert.equal(rows[0].n, 1);
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

test("27 all four titles and all four genders are accepted", async () => {
  const slots = await makeSlots(4);
  const titles = ["Mr.", "Mrs.", "Ms.", "Miss"];
  const genders = ["Male", "Female", "Non-binary", "Prefer not to say"];
  for (let i = 0; i < 4; i++) {
    const res = await book(slots[i], person({ title: titles[i], gender: genders[i] }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.booking.CustomerTitle, titles[i]);
    assert.equal(res.body.data.booking.Gender, genders[i]);
  }
});

test("28 a custom ('Other') profession is stored trimmed and shown to the admin", async () => {
  const [slot] = await makeSlots(1);
  const res = await book(slot, person({ title: "Miss", gender: "Female", profession: "  Marine Biologist  " }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.booking.Profession, "Marine Biologist");

  const list = await api("GET", "/api/bookings");
  const row = list.body.data.bookings[0];
  assert.equal(row.CustomerTitle, "Miss");
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
