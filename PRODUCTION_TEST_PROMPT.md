# Prompt for GitHub Copilot: test the live booking page

Paste everything below the line into Copilot Chat (agent mode with a browser / Playwright MCP tool,
or ask it to write and run a Playwright script). Replace the two placeholders first.

> **Heads-up:** this creates REAL bookings on the live site and sends REAL emails. Use throwaway
> addresses you control (e.g. `yourname+t1@gmail.com`, `+t2`, `+t3`) and cancel/delete the test
> bookings from the admin panel afterwards. The site allows only ONE upcoming booking per email or
> phone number, so every scenario below uses a different email AND phone number.

---

You are a QA automation engineer. Test the live booking form at **https://niyotishrivastava.com/booking.html**
end to end in a real browser (Playwright preferred). Do not modify any code. Report results as a
table: `# | scenario | expected | actual | PASS/FAIL`, with a screenshot for every FAIL.

Test data: emails `<MY_EMAIL>+t1@gmail.com`, `+t2`, `+t3`, `+t4`; phones `9000000101` .. `9000000104`
(country code +91). Admin login (only for scenario 12): `<ADMIN_EMAIL>` / `<ADMIN_PASSWORD>` at
https://niyotishrivastava.com/admin-login.html.

## Form structure
1. The form has a **Title** dropdown beside Full Name with exactly: Mr., Mrs., Ms., Miss (plus an empty "Title" placeholder).
2. A **Gender** dropdown with exactly: Male, Female, Non-binary, Prefer not to say (plus an empty placeholder).
3. A **Profession** dropdown with 30+ entries, starting with an empty placeholder and ending with **Other**.
   The free-text box "Type your profession" is hidden until "Other" is selected.

## Behaviour
4. Select Profession = Other -> the text box appears and is required. Select "Student" -> it hides and its text is cleared.
5. Try to submit with Title, Gender or Profession empty -> the browser blocks the submit (required validation) and no
   POST to `/api/public/bookings` is sent. Also try Profession = Other with an empty text box -> blocked.
6. Available Date lists only dates within the next 14 days; selecting a date fills Available Time.
7. Happy path A (email +t1): Title Ms., Name "QA Testone", Gender Female, Profession = Other -> type "Marine Biologist",
   choose the first date/time, question "automated test", submit -> green success message with a Reference.
8. Happy path B (email +t2): Title Mr., Name "QA Testtwo", Gender Male, Profession "Software Engineer / IT Professional", next slot -> success.
9. Duplicate person: repeat with email +t1 but phone 9000000103 -> red error containing "already have an upcoming appointment".
   Repeat with email +t3 but phone 9000000101 (same phone as scenario 7) -> same error.
10. Each of Title = Miss / Mrs. and Gender = Non-binary / Prefer not to say can be submitted successfully (use emails +t3 and +t4 with new phones).
11. The booked slots from scenarios 7-10 no longer appear in the Available Date/Time lists after reloading the page.
12. Log in to the admin panel -> Bookings: the table has "Gender" and "Profession" columns; the row for scenario 7 reads
    "Ms. QA Testone", Female, "Marine Biologist". Then clean up: cancel or delete all the test bookings.
13. Security: submit a booking with Profession = Other and text `<img src=x onerror=alert(1)>` (use a fresh email/phone).
    In the admin Bookings table the text must appear literally (no alert dialog, no broken image). Then delete that booking.
14. Layout: repeat scenarios 1-3 at 375x812 (mobile) - all fields visible, nothing overflows horizontally.

Finish with a summary: total passed/failed and anything that looked odd (slow responses, console errors, layout glitches).
