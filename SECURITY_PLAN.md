# CLEARIT — Auth & Row-Level Security Rework

Status: **Phase 0 shipped, Phases 1–4 pending.**

## Why this plan exists

`supabaseConfig.js` states the anon key is intentionally public and that "real
security lives in Supabase RLS policies." The key really is public — on a static
site it cannot be otherwise — so RLS is the only thing standing between a visitor
and your data. On 2026-10-08 that was tested from a browser with no session
(`auth.getSession()` → `none`):

| Probe | Result |
|---|---|
| Read all 10 `signatories` (emails, names) | open |
| Read all 6 `students` (IDs, names, programs) | open |
| Read all 210 `clearance_records` | open |
| Read `password_hash` | open |
| Update an existing row | **allowed** |

The write probe sets a row to the value it already holds, so the data cannot
change either way — if RLS filtered the row, PostgREST returns `[]`; if it does
not, RLS permitted the write. It returned the row. Data was byte-identical
before and after.

Cause is `clearit_schema.sql:434-438` — RLS is *enabled* on all five tables but
every policy is:

```sql
CREATE POLICY "allow_all students" ON students FOR ALL USING (true) WITH CHECK (true);
```

There is a second layer: **the app never authenticates with Supabase Auth.**
No `signInWithPassword` exists in `app.js` or `db.js`. Login is a client-side
table lookup — `db.js:51` fetches the row *including `password_hash`* and
verifies it with `window.bcrypt.compareSync` (`db.js:74`, `db.js:120`), then
`app.js:643` holds the result in an in-memory `currentUser`. Nothing server-side
re-establishes identity afterwards, so `auth.uid()` is `null` for every visitor.

Consequently no ID-hiding trick helps: there is no identity to gate on, and the
row policies permit everything regardless.

Related defects found while mapping this:

- `clearit_remember` stored the **plaintext password** (`app.js:815`). Fixed in Phase 0.
- `db.js:579` calls `supabase.auth.resetPasswordForEmail`, but no Auth users
  exist, so the forgot-password email links to nothing. It cannot work today.
- `app.js:640` and `app.js:661` printed demo credentials in login error hints. Fixed in Phase 0.

## Decisions taken

1. **Passwords:** Supabase Auth will not accept the existing bcrypt hashes.
   Demo accounts keep their known plaintexts (`password123`, `admin123`);
   every other account gets a temporary password and is forced to change it on
   first login.
2. **Demo buttons:** the three auto-fill buttons stay, now signing in through
   Supabase Auth with the same credentials they type today.

## Phase 0 — shipped

No lockout risk, requires no Auth users.

- `persistRemember` no longer writes `pass`; `restoreRemember` never reads it
  back and **purges a `pass` key left behind by older builds on sight**.
- Login error hints no longer suggest working credentials.

## Phase 1 — create Auth users

For each row in `students` and `signatories`, create an `auth.users` user whose
`id` **is the existing row UUID**. That makes `auth.uid() = students.id` work
with no link column and no join.

Requires the `service_role` key, used only from a local script — never shipped
to the browser. Add `email_confirm: true` so nobody is blocked on a
confirmation screen.

Non-destructive: it only *adds* users. Safe to run while RLS is still `allow_all`.

## Phase 2 — replace `allow_all` — **must run last**

| Table | Policy |
|---|---|
| `students` | own row, `id = auth.uid()` |
| `signatories` | own row |
| `clearance_records` | student reads own; officer writes for their category in the active term |
| `semesters`, `signatory_categories` | read for any signed-in user |
| `signatures` bucket | officer writes own `signatory-<uid>-` prefix |

## Phase 3 — app changes

1. `loginStudent` / `loginSignatory` → `supabase.auth.signInWithPassword`.
   `password_hash` leaves the client entirely; drop it from the SELECT lists.
2. Session bootstrap via `getSession()` on load, so a refresh keeps you signed
   in (`currentUser` is memory-only today).
3. Password change → `supabase.auth.updateUser({ password })`. The forgot-password
   flow then actually works for the first time.
4. Demo buttons sign in through Auth.

## Phase 4 — cleanup

1. Drop `password_hash` from `students` and `signatories`.
2. Drop the five `allow_all` policies.
3. Replace the SAS director email hardcode at `app.js:443` with a role column.

## Ordering risk — do not skip

**Phases 1 and 3 must be live before Phase 2.** `index.html` references `db.js`
and `app.js` with no cache-buster, so stale client code lingers — this has
already produced several false test failures in this project. If policies tighten
while a visitor still runs the old login code, they face a login screen with no
way through.

Deploy order: Auth users → new client code → verify on the live site → *then*
drop `allow_all`.

## Verification

- `node sigtest.js` — 170 checks (frontend)
- `node sigstoragetest.js` — 82 checks (storage layer)
- `sigtest.sql` 44, `functest.sql` 51
- `deploy/` must stay byte-identical to the repo root
- After Phase 2: an anonymous browser session must read **0 rows** from every
  table — the exact probe that currently returns 10 / 6 / 210.

## Notes

- Netlify is blocked until 2026-10-19; GitHub Pages is the live target.
- As of 2026-10-08 the dean's signature, the `clearance_records` snapshot and all
  bucket objects are empty (they were populated on 2026-10-05).
  `clearSignatorySignature` never touches `clearance_records` and no SQL in this
  repo contains `DELETE`/`TRUNCATE`, so the cause is not in the code here.
  Unrelated to this rework; the officer needs to redraw.
