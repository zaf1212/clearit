#!/usr/bin/env node
// =============================================================================
// CLEARIT — Phase 1 of SECURITY_PLAN.md: create Supabase Auth users.
//
// The app currently logs in by fetching a row from `students` / `signatories`
// and comparing `password_hash` in the browser. That means auth.uid() is null
// for every visitor, so no RLS policy can gate anything - which is why every
// table is world-readable today.
//
// This script creates a real Supabase Auth user for each existing account,
// using the account's CURRENT row UUID as the Auth user id. That makes
//     auth.uid() = students.id
// work with no link column and no join.
//
// It only ADDS users. It cannot lock anyone out: RLS is still `allow_all`
// until Phase 2, which must not run until the new client code is live.
//
// DEPENDENCIES: none - plain fetch, no npm install.
//
// Usage:
//   SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_URL=... node tools/create-auth-users.mjs
//
// or put them in an untracked .env file next to this script's parent directory.
// The service key MUST NEVER be committed or shipped to the browser.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ── Environment ─────────────────────────────────────────────────────────────
function loadEnv () {
  const found = {};
  for (const name of ['.env', '.env.local', 'service-key.local.env']) {
    const p = resolve(ROOT, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
      if (!m) continue;
      found[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  return { ...found, ...process.env };
}

const env = loadEnv();
const URL_BASE = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || env.SERVICE_ROLE_KEY || '';

if (!URL_BASE || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY.');
  console.error('Find them in Supabase Dashboard -> Settings -> API.');
  console.error('Provide them as environment variables or in an untracked .env file:');
  console.error('  SUPABASE_URL=https://fnzuzzcyjvfqwrjfhmie.supabase.co');
  console.error('  SUPABASE_SERVICE_ROLE_KEY=eyJ...');
  console.error('\nRefusing to continue: without them no Auth user can be created.');
  process.exit(1);
}

// Do not let the key echo into a log or shell history.
const KEY_FINGERPRINT = SERVICE_KEY.slice(0, 8) + '...' + SERVICE_KEY.slice(-4);

// ── Passwords ───────────────────────────────────────────────────────────────
// Accounts seeded by clearit_schema.sql keep their known demo password and are
// NOT forced to change it - they are the credentials the demo buttons type.
// Every other account gets a temporary password and must change it on first
// login, because Supabase Auth cannot import the existing bcrypt hash.
const DEMO_PASSWORDS = {
  // students: crypt('password123', ...)
  'jerame.abing@tcc.edu.ph':   'password123',
  'maria.santos@tcc.edu.ph':   'password123',
  'pedro.reyes@tcc.edu.ph':    'password123',
  'ana.garcia@tcc.edu.ph':     'password123',
  'jose.ramirez@tcc.edu.ph':   'password123',
  // signatories: crypt('admin123', ...)
  'arnel.zafra@tcc.edu.ph':        'admin123',
  'riza.archival@tcc.edu.ph':      'admin123',
  'mae.abellana@tcc.edu.ph':       'admin123',
  'malourdes.mediano@tcc.edu.ph':  'admin123',
  'jade.geraldez@tcc.edu.ph':      'admin123',
  'fritzie.formis@tcc.edu.ph':     'admin123',
  'jennilyn.geagonia@tcc.edu.ph':  'admin123',
  'wendelyn.labajo@tcc.edu.ph':    'admin123',
  'glen.tabucanon@tcc.edu.ph':     'admin123',
  'richel.bacaltos@tcc.edu.ph':    'admin123'
};

function tempPassword (account) {
  // Derived from something the person already knows and the admin can read off
  // the report below. Temporary by construction: it is replaced on first login.
  if (account.kind === 'student' && account.institutional_id) {
    return 'Clearit-' + account.institutional_id;
  }
  return 'Clearit-' + String(account.email).split('@')[0];
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
async function rest (path, opts = {}) {
  const res = await fetch(URL_BASE + path, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok && !opts.allowError) {
    const msg = body && body.message ? body.message : (typeof body === 'string' ? body : JSON.stringify(body));
    throw new Error(`${opts.label || path} -> HTTP ${res.status}: ${msg}`);
  }
  return { status: res.status, body };
}

async function listAllAuthUsers () {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const r = await rest(`/auth/v1/admin/users?page=${page}&per_page=200`, { label: 'list auth users' });
    const users = (r.body && r.body.users) || [];
    out.push(...users);
    if (users.length < 200) break;
  }
  return out;
}

// ── Accounts to migrate ─────────────────────────────────────────────────────
async function loadAccounts () {
  const [students, signatories] = await Promise.all([
    rest('/rest/v1/students?select=id,email,institutional_id,full_name&order=institutional_id',
         { label: 'read students' }),
    rest('/rest/v1/signatories?select=id,email,full_name&order=email',
         { label: 'read signatories' })
  ]);
  const s = (students.body || []).map(r => ({ ...r, kind: 'student' }));
  const o = (signatories.body || []).map(r => ({ ...r, kind: 'signatory' }));
  return [...s, ...o];
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main () {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Supabase: ${URL_BASE}`);
  console.log(`Service key: ${KEY_FINGERPRINT} (never printed in full, never committed)`);
  if (dryRun) console.log('DRY RUN - no users will be created.\n');

  const [accounts, existing] = await Promise.all([loadAccounts(), listAllAuthUsers()]);
  const byId = new Map(existing.map(u => [String(u.id), u]));
  const byEmail = new Map(existing.filter(u => u.email).map(u => [u.email.toLowerCase(), u]));

  console.log(`Found ${accounts.length} accounts, ${existing.length} already in Supabase Auth.\n`);

  const created = [], skipped = [], failed = [];
  for (const a of accounts) {
    const email = (a.email || '').trim().toLowerCase();
    if (!email) { failed.push({ a, why: 'no email on the row' }); continue; }

    if (byId.has(String(a.id))) { skipped.push({ a, why: 'id already exists' }); continue; }
    if (byEmail.has(email)) {
      failed.push({ a, why: `Auth user exists with a DIFFERENT id (${byEmail.get(email).id}) - resolve by hand` });
      continue;
    }

    const isDemo = Object.prototype.hasOwnProperty.call(DEMO_PASSWORDS, email);
    const password = isDemo ? DEMO_PASSWORDS[email] : tempPassword(a);
    const mustChange = !isDemo;

    if (dryRun) { created.push({ a, password, mustChange, dry: true }); continue; }

    try {
      const r = await rest('/auth/v1/admin/users', {
        method: 'POST',
        label: 'create user',
        allowError: true,
        body: JSON.stringify({
          id: a.id,
          email,
          password,
          email_confirm: true,   // no one should be blocked on a confirmation screen
          user_metadata: {
            must_change_password: mustChange,
            account_type: a.kind,
            full_name: a.full_name
          },
          app_metadata: { account_type: a.kind }
        })
      });
      if (r.status >= 300) {
        failed.push({ a, why: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) });
        continue;
      }
      created.push({ a, password, mustChange });
    } catch (e) {
      failed.push({ a, why: e.message });
    }
  }

  const line = '-'.repeat(96);
  if (created.length) {
    console.log(line);
    console.log(created.length === 1 ? '1 ACCOUNT READY' : `${created.length} ACCOUNTS READY`);
    console.log(line);
    for (const c of created) {
      console.log(
        `  ${(c.a.full_name || '').padEnd(28)} ${c.a.email.padEnd(32)} ${c.password}` +
        (c.mustChange ? '   <- forced change on first login' : '   (demo, unchanged)')
      );
    }
    console.log('');
  }
  if (skipped.length) console.log(`Skipped ${skipped.length} already present.`);
  if (failed.length) {
    console.log(`\nFAILED ${failed.length}:`);
    for (const f of failed) console.log(`  ${f.a.email}: ${f.why}`);
  }

  console.log(`\nCreated ${created.length}, skipped ${skipped.length}, failed ${failed.length}.`);
  console.log('Next: ship the signInWithPassword client code, verify it live,');
  console.log('THEN and only then drop the allow_all policies (Phase 2).');

  process.exit(failed.length ? 1 : 0);
}

main().catch(e => {
  console.error('\nFATAL: ' + e.message);
  process.exit(1);
});
