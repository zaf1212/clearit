// db.js — Supabase data-access layer for CLEARIT
// Depends on: window.supabase (initialized via ESM import in index.html),
//             window.bcrypt (bcryptjs)

var DB = (function () {
  'use strict';

  // ── Friendly error helper ──────────────────────────────────────────────
  // Turns raw Supabase errors into a stable, human-readable Error so callers
  // never have to handle cryptic Supabase internals.
  function friendlyError (err, context) {
    var raw = (err && err.message) ? err.message : String(err || 'Unknown error');
    // Communicate connection problems in plain language
    if (/fetch|network|Failed to fetch|Load failed/i.test(raw)) {
      return new Error('Cannot reach the database server. Check your internet connection and try again.');
    }
    if (/404|Not Found/i.test(raw)) {
      return new Error('Requested data was not found. The database may not be set up yet (run clearit_schema.sql).');
    }
    if (/23505/i.test(raw)) {
      return new Error('That record already exists (duplicate value).');
    }
    if (/permission|RLS|403/i.test(raw)) {
      return new Error('Database permission denied. Check Supabase RLS policies.');
    }
    return new Error((context ? context + ': ' : '') + raw);
  }

  // Split the legacy combined "1st Year / Charity" value into Year + Section.
  function splitYearBlock (yearBlock) {
    var year = '', section = '';
    if (yearBlock) {
      var parts = String(yearBlock).split('/').map(function (p) { return p.trim(); });
      year = parts[0] || '';
      section = parts[1] || '';
    }
    return { yearLevel: year, sectionBlock: section };
  }

  // ── Signatory categories ───────────────────────────────────────────────
  async function getCategories () {
    var { data, error } = await window.supabase
      .from('signatory_categories')
      .select('id, key, name, signatory_name')
      .order('display_order');
    if (error) throw friendlyError(error);
    return data || [];
  }

  // ── Auth: student login (query + bcryptjs verify) ──────────────────────
  async function loginStudent (institutionalId, password) {
    var data = null;
    try {
      var r1 = await window.supabase
        .from('students')
        .select('id, full_name, email, institutional_id, year_block, program, semester, academic_year, enrollment_status, paid, paid_date, password_hash, password_change_count')
        .eq('institutional_id', institutionalId)
        .maybeSingle();
      if (r1.error) throw r1.error;
      data = r1.data;
    } catch (e) {
      // Graceful degrade if the SQL migration hasn't run yet (column missing).
      var r2 = await window.supabase
        .from('students')
        .select('id, full_name, email, institutional_id, year_block, program, semester, academic_year, enrollment_status, paid, paid_date, password_hash')
        .eq('institutional_id', institutionalId)
        .maybeSingle();
      if (r2.error) throw friendlyError(r2.error, 'Could not sign you in');
      data = r2.data;
    }

    if (!data) return { ok: false, error: 'No account found for that Student ID.' };

    var valid = window.bcrypt && window.bcrypt.compareSync(password, data.password_hash);
    if (!valid) return { ok: false, error: 'Invalid password. Please try again.' };

    return {
      ok: true,
      id: data.id,
      name: data.full_name,
      email: data.email,
      i_id: data.institutional_id,
      block: data.year_block,
      program: data.program,
      semester: data.semester,
      academic_year: data.academic_year,
      enrollment_status: data.enrollment_status,
      paid: data.paid,
      paid_date: data.paid_date,
      password_change_count: (data.password_change_count == null ? 0 : data.password_change_count)
    };
  }

  // ── Auth: signatory login (query + bcryptjs verify + category join) ────
  async function loginSignatory (email, password) {
    var { data, error } = await window.supabase
      .from('signatories')
      .select('id, full_name, email, password_hash, role, category_id, signatory_categories(id, key, name)')
      .eq('email', email)
      .maybeSingle();

    if (error) throw friendlyError(error, 'Could not sign you in');
    if (!data) return { ok: false, error: 'No account found for that email.' };

    var valid = window.bcrypt && window.bcrypt.compareSync(password, data.password_hash);
    if (!valid) return { ok: false, error: 'Invalid password. Please try again.' };

    var cat = data.signatory_categories;
    return {
      ok: true,
      id: data.id,
      name: data.full_name,
      email: data.email,
      role: data.role || 'signatory',
      category_id: cat.id,
      category_key: cat.key,
      category_name: cat.name
    };
  }

  // ── Student clearance detail (one student, one semester) ───────────────
  async function getStudentClearance (studentUUID, semester, academicYear) {
    var q = window.supabase
      .from('v_clearance_details')
      .select('category_key, category_name, signatory_name, status, remarks, signed_at, signed_by_name')
      .eq('student_id', studentUUID)
      .order('display_order');
    if (semester) q = q.eq('record_semester', semester);
    if (academicYear) q = q.eq('record_academic_year', academicYear);
    var { data, error } = await q;
    if (error) throw friendlyError(error, 'Could not load your clearance');
    return data || [];
  }

  // True when the student has pending/hold records in the given term
  // (used to block a student from a later semester's clearance).
  async function hasOutstandingClearance (studentId, semester, academicYear) {
    var rows = await getStudentClearance(studentId, semester, academicYear);
    return rows.some(function (r) { return r.status === 'pending' || r.status === 'hold'; });
  }

  // ── Students with clearance for one semester (signatory dashboard) ─────
  async function getAllStudentClearance (semester, academicYear) {
    // Try with the migrated academic_status / year_level / section_block columns
    // first, then fall back through progressively older view shapes so the app
    // keeps working before clearit_academic_status_migration.sql has been run.
    var attempts = [
      'student_id, institutional_id, student_name, year_block, program, academic_status, year_level, section_block, category_key, category_name, signatory_name, status, remarks, signed_at, signed_by_name',
      'student_id, institutional_id, student_name, year_block, program, year_level, section_block, category_key, category_name, signatory_name, status, remarks, signed_at, signed_by_name',
      'student_id, institutional_id, student_name, year_block, program, category_key, category_name, signatory_name, status, remarks, signed_at, signed_by_name'
    ];
    var rows = null, lastErr = null;
    for (var i = 0; i < attempts.length; i++) {
      var q = window.supabase.from('v_clearance_details').select(attempts[i]).order('display_order');
      if (semester) q = q.eq('record_semester', semester);
      if (academicYear) q = q.eq('record_academic_year', academicYear);
      var r = await q;
      if (!r.error) { rows = r.data || []; break; }
      lastErr = r.error;
    }
    if (!rows) throw friendlyError(lastErr, 'Could not load student clearances');
    return rows.map(function (r) {
      var parts = splitYearBlock(r.year_block);
      r.yearLevel = r.year_level || parts.yearLevel;
      r.sectionBlock = r.section_block || parts.sectionBlock;
      r.academicStatus = r.academic_status || 'Active';
      return r;
    });
  }

  // ── Students whose semester / A.Y. tags match the SELECTED term ──────────
  // Reads v_student_progress (cohort + progress, filtered by the same semester
  // as the clearance records) so the dashboard always reflects the dropdown.
  // Falls back to the students table if the view isn't installed yet, and to
  // splitting year_block if the migrated year_level/section_block columns
  // (or the view columns) don't exist yet.
  async function getStudentsForSemester (semester, academicYear) {
    var attempts = [
      { from: 'v_student_progress', idKey: 'student_id', cols: 'student_id, institutional_id, full_name, year_block, program, academic_status, year_level, section_block' },
      { from: 'v_student_progress', idKey: 'student_id', cols: 'student_id, institutional_id, full_name, year_block, program, year_level, section_block' },
      { from: 'v_student_progress', idKey: 'student_id', cols: 'student_id, institutional_id, full_name, year_block, program' },
      { from: 'students',           idKey: 'id',          cols: 'id, institutional_id, full_name, year_block, program, academic_status, year_level, section_block' },
      { from: 'students',           idKey: 'id',          cols: 'id, institutional_id, full_name, year_block, program, year_level, section_block' },
      { from: 'students',           idKey: 'id',          cols: 'id, institutional_id, full_name, year_block, program' }
    ];
    var rows = null, lastErr = null, usedIdKey = 'student_id';
    for (var i = 0; i < attempts.length; i++) {
      var a = attempts[i];
      var q = window.supabase.from(a.from).select(a.cols).in('enrollment_status', ['Regular', 'Irregular']);
      if (semester) q = q.eq('semester', semester);
      if (academicYear) q = q.eq('academic_year', academicYear);
      var r = await q;
      if (!r.error) { rows = r.data || []; usedIdKey = a.idKey; break; }
      lastErr = r.error;
    }
    if (!rows) throw friendlyError(lastErr, 'Could not load students for this term');
    return rows.map(function (r) {
      var parts = splitYearBlock(r.year_block);
      return {
        student_id: r[usedIdKey], institutional_id: r.institutional_id,
        full_name: r.full_name, year_block: r.year_block, program: r.program,
        academicStatus: r.academic_status || 'Active',
        yearLevel: r.year_level || parts.yearLevel,
        sectionBlock: r.section_block || parts.sectionBlock
      };
    });
  }

  // ── Stamp ALL ACTIVE students with the newly initialized term ───────────
  // Called right before/after fn_init_clearance so every active (Regular /
  // Irregular) student's semester + academic_year match the new term.
  // Dropped / Suspended / Graduated / Inactive students are left on their old
  // term tags, so they never look like part of the new roster. Falls back to
  // the pre-migration shape if academic_status has not been added yet.
  async function updateActiveStudentsSemester (semester, academicYear) {
    var attempts = [
      function (q) { return q.eq('academic_status', 'Active'); },
      function (q) { return q; }
    ];
    var lastErr = null, done = false;
    for (var i = 0; i < attempts.length && !done; i++) {
      var q = window.supabase
        .from('students')
        .update({ semester: semester, academic_year: academicYear })
        .in('enrollment_status', ['Regular', 'Irregular']);
      var r = await attempts[i](q);
      if (!r.error) done = true;
      else lastErr = r.error;
    }
    if (!done) throw friendlyError(lastErr, 'Could not update student semester tags');
  }

  // ── Distinct (semester, academic_year) pairs that exist ────────────────
  async function getSemesterOptions () {
    var seen = {}, out = [];

    function addOpt(sem, ay) {
      if (!sem || !ay) return;
      var key = sem + '|' + ay;
      if (!seen[key]) { seen[key] = true; out.push({ semester: sem, academic_year: ay }); }
    }

    // Prefer semesters registered by the SAS Director (even if no clearance
    // records exist yet), then fall back to whatever clearance data exists.
    try {
      var sres = await window.supabase.from('semesters').select('semester, academic_year');
      if (!sres.error) (sres.data || []).forEach(function (r) { addOpt(r.semester, r.academic_year); });
    } catch (e) { /* semesters table may not exist on older installs */ }

    var { data, error } = await window.supabase
      .from('clearance_records')
      .select('semester, academic_year');
    if (error) throw friendlyError(error, 'Could not load semester options');

    (data || []).forEach(function (r) { addOpt(r.semester, r.academic_year); });
    return out;
  }

  // ── Admin: get all students ─────────────────────────────────────────────
  // Decorate each row with camelCase yearLevel / sectionBlock: from the
  // migrated columns when present, otherwise split from year_block.
  async function getAllStudents () {
    var attempts = [
      'id, institutional_id, full_name, email, year_block, program, semester, academic_year, enrollment_status, academic_status, paid, paid_date, password_change_count, year_level, section_block',
      'id, institutional_id, full_name, email, year_block, program, semester, academic_year, enrollment_status, paid, paid_date, password_change_count, year_level, section_block',
      'id, institutional_id, full_name, email, year_block, program, semester, academic_year, enrollment_status, paid, paid_date, password_change_count'
    ];
    var rows = null, lastErr = null;
    for (var i = 0; i < attempts.length; i++) {
      var r = await window.supabase.from('students').select(attempts[i]).order('institutional_id');
      if (!r.error) { rows = r.data || []; break; }
      lastErr = r.error;
    }
    if (!rows) throw friendlyError(lastErr, 'Could not load the student list');
    return rows.map(function (s) {
      if (!('password_change_count' in s)) s.password_change_count = 0;
      var parts = splitYearBlock(s.year_block);
      s.yearLevel = s.year_level || parts.yearLevel;
      s.sectionBlock = s.section_block || parts.sectionBlock;
      // Pre-migration databases have no academic_status column; treat the
      // whole roster as Active so the status UI degrades gracefully.
      s.academicStatus = s.academic_status || 'Active';
      return s;
    });
  }

  // ── Student: change own password (new hash + incremented change counter) ─
  // newCount is the counter value to set AFTER this change (app enforces < 3).
  async function changeStudentPassword (studentUUID, passwordHash, newCount) {
    var { error } = await window.supabase
      .from('students')
      .update({ password_hash: passwordHash, password_change_count: newCount })
      .eq('id', studentUUID);
    if (error) throw friendlyError(error, 'Could not change the password');
  }

  // ── Signatory / Admin: change own password (no usage limit / counter) ───
  // The app signs signatories in against the signatories table (bcrypt hashes
  // verified client-side) rather than Supabase native Auth, so the direct
  // record update is the exact equivalent of auth.updateUser({password}) for
  // this architecture — and it never touches password_change_count.
  async function changeSignatoryPassword (signatoryUUID, passwordHash) {
    var { error } = await window.supabase
      .from('signatories')
      .update({ password_hash: passwordHash })
      .eq('id', signatoryUUID);
    if (error) throw friendlyError(error, 'Could not change the password');
  }

  // ── Forgot Password: resolve a Student ID to its official TCC email ─────
  // Read-only lookup used by the login page to address the recovery email.
  async function findStudentByInstitutionalId (institutionalId) {
    var { data, error } = await window.supabase
      .from('students')
      .select('id, full_name, email, institutional_id, password_change_count')
      .eq('institutional_id', institutionalId)
      .maybeSingle();
    if (error) throw friendlyError(error, 'Could not verify the student account');
    return data || null;
  }

  // ── Forgot Password: send a Supabase (GoTrue) email recovery link ───────
  // Delegates to supabase.auth.resetPasswordForEmail so the reset is verified
  // by an emailed link/code. Nothing is written to the students/signatories
  // tables from the public login page — no direct password row overwrite.
  async function sendPasswordResetEmail (email) {
    var { error } = await window.supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin
    });
    if (error) throw friendlyError(error, 'Could not send the password reset email');
    return true;
  }

  // ── Admin (SAS Director): reset a student's change counter back to 0 ───
  async function resetPasswordChangeCount (studentUUID) {
    var { error } = await window.supabase
      .from('students')
      .update({ password_change_count: 0 })
      .eq('id', studentUUID);
    if (error) throw friendlyError(error, 'Could not reset the password change limit');
  }

  // ── Admin: update a student ────────────────────────────────────────────
  async function updateStudent (studentUUID, fields) {
    var { error } = await window.supabase
      .from('students')
      .update(fields)
      .eq('id', studentUUID);
    if (error) throw friendlyError(error, 'Could not update the student');
  }

  // ── SAS Director: batch-assign Year Level + Section/Block to students ──
  // updates: [{ id, year_level, section_block, year_block }]. Also rewrites
  // the legacy combined year_block so every existing dashboard that displays
  // it (student + signatory views) reflects the new value immediately.
  async function assignStudentsYearSection (updates) {
    if (!updates || !updates.length) throw new Error('No students selected.');
    var results = await Promise.all(updates.map(function (u) {
      return window.supabase
        .from('students')
        .update({
          year_level:    u.year_level,
          section_block: u.section_block,
          year_block:    u.year_block
        })
        .eq('id', u.id);
    }));
    var failed = results.filter(function (r) { return r.error; });
    if (failed.length) {
      throw friendlyError(failed[0].error, 'Could not update student records — run clearit_year_section_migration.sql in the Supabase SQL editor first (Year/Section columns missing)');
    }
    return updates.length;
  }

  // ── Admin: register a new student + initialize clearance records ──────
  async function createStudent (studentFields) {
    var { data: student, error: err1 } = await window.supabase
      .from('students')
      .insert(studentFields)
      .select('id')
      .single();
    if (err1) throw friendlyError(err1, 'Could not register the student');

    var { data: cats, error: err2 } = await window.supabase
      .from('signatory_categories')
      .select('id')
      .order('display_order');
    if (err2) throw friendlyError(err2, 'Could not initialize clearance records');

    if (cats && cats.length > 0) {
      var semester      = studentFields.semester      || '1st Semester';
      var academicYear  = studentFields.academic_year || '2025-2026';
      var clearanceRows = cats.map(function (c) {
        return { student_id: student.id, category_id: c.id, status: 'pending', semester: semester, academic_year: academicYear };
      });
      var { error: err3 } = await window.supabase
        .from('clearance_records')
        .insert(clearanceRows);
      if (err3) throw friendlyError(err3, 'Could not initialize clearance records');
    }

    return student.id;
  }

  // ── Starting a new semester cycle: initialize clearances for ACTIVE students
  // Optional p_year_level / p_section_block narrow the batch to a specific
  // Year Level and/or Section; p_student_ids narrows it to an explicit roster.
  // Students whose academic_status is Dropped / Suspended / Graduated /
  // Inactive are skipped by the RPC, so they are never initialized.
  // The 2-argument call keeps working on pre-migration databases.
  async function initializeClearance (semester, academicYear, yearLevel, sectionBlock, studentIds, sasEmail) {
    var params = { p_semester: semester, p_academic_year: academicYear };
    if (yearLevel)    params.p_year_level = yearLevel;
    if (sectionBlock) params.p_section_block = sectionBlock;
    if (studentIds && studentIds.length) params.p_student_ids = studentIds;
    if (sasEmail) params.p_sas_email = sasEmail;
    var { data, error } = await window.supabase.rpc('fn_init_clearance', params);
    if (error) {
      if (yearLevel || sectionBlock || (studentIds && studentIds.length)) {
        throw friendlyError(error, 'Year/Section filtering requires the database migration — run clearit_academic_status_migration.sql in the Supabase SQL editor');
      }
      throw friendlyError(error, 'Could not initialize clearance records');
    }
    return data || 0;
  }

  // ── SAS Director: one-call "Initialize New Semester" wizard ──────────────
  // opts: { semester, academicYear, mode: 'roll_forward'|'custom',
  //         studentIds: [], promote: bool, yearLevel, sectionBlock,
  //         activate: bool, sasEmail }
  // Runs entirely inside the database in a single transaction and returns a
  // JSONB breakdown. Never updates or deletes existing clearance history.
  async function initNewTerm (opts) {
    var params = {
      p_semester:      opts.semester,
      p_academic_year: opts.academicYear,
      p_mode:          opts.mode,
      p_promote:       !!opts.promote,
      p_activate:      opts.activate !== false,
      p_sas_email:     opts.sasEmail
    };
    if (opts.studentIds && opts.studentIds.length) params.p_student_ids = opts.studentIds;
    if (opts.yearLevel)                       params.p_year_level    = opts.yearLevel;
    if (opts.sectionBlock)                     params.p_section_block = opts.sectionBlock;

    var { data, error } = await window.supabase.rpc('fn_init_new_term', params);
    if (error) {
      throw friendlyError(error, isMigrationMissing(error)
        ? 'Term initialization needs the database migration — run clearit_academic_status_migration.sql in the Supabase SQL editor'
        : 'Could not initialize the new term');
    }
    return data || {};
  }

  // ── SAS Director: apply an uploaded CSV roster row by row ───────────────
  // rows: [{ institutional_id, academic_status, year_level, section_block }]
  async function applyRosterUpload (rows, sasEmail) {
    var { data, error } = await window.supabase.rpc('fn_apply_roster_upload', {
      p_rows:      rows,
      p_sas_email: sasEmail
    });
    if (error) {
      throw friendlyError(error, isMigrationMissing(error)
        ? 'CSV roster upload needs the database migration — run clearit_academic_status_migration.sql in the Supabase SQL editor'
        : 'Could not apply the uploaded roster');
    }
    return data || {};
  }

  // ── SAS Director: quick status toggles (Dropped / Suspended / ...) ─────
  async function setStudentAcademicStatus (studentIds, academicStatus, sasEmail) {
    var { data, error } = await window.supabase.rpc('fn_set_student_academic_status', {
      p_student_ids:     studentIds,
      p_academic_status: academicStatus,
      p_sas_email:       sasEmail
    });
    if (error) {
      throw friendlyError(error, isMigrationMissing(error)
        ? 'Changing student status needs the database migration — run clearit_academic_status_migration.sql in the Supabase SQL editor'
        : 'Could not change the student status');
    }
    return data || 0;
  }

  // Supabase reports a missing RPC as "function ... does not exist" (code
  // 42883 / PGRST202). Detect that so the UI can point at the migration file
  // instead of showing a raw database error.
  function isMigrationMissing (error) {
    if (!error) return false;
    var msg = String(error.message || '');
    return /does not exist|not found|42883|PGRST202|schema cache/i.test(msg);
  }

  // ── Semester management (SAS Director access is enforced inside the RPCs) ──
  async function getSemesters () {
    var { data, error } = await window.supabase
      .from('semesters')
      .select('id, semester, academic_year, is_active, created_at');
    if (error) throw friendlyError(error, 'Could not load semesters');
    return data || [];
  }

  async function getActiveSemester () {
    var { data, error } = await window.supabase
      .from('semesters')
      .select('semester, academic_year')
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw friendlyError(error, 'Could not load the active semester');
    return data || null;
  }

  async function createSemester (semester, academicYear, sasEmail) {
    var { data, error } = await window.supabase.rpc('fn_upsert_semester', {
      p_semester:      semester,
      p_academic_year: academicYear,
      p_sas_email:     sasEmail
    });
    if (error) throw friendlyError(error, 'Could not create the semester');
    return data;
  }

  async function activateSemester (semesterId, sasEmail) {
    var { error } = await window.supabase.rpc('fn_activate_semester', {
      p_semester_id: semesterId,
      p_sas_email:   sasEmail
    });
    if (error) throw friendlyError(error, 'Could not set the active semester');
  }

  async function updateSemester (semesterId, semesterName, academicYear, sasEmail) {
    var { error } = await window.supabase.rpc('fn_update_semester', {
      p_semester_id:   semesterId,
      p_semester:      semesterName,
      p_academic_year: academicYear,
      p_sas_email:     sasEmail
    });
    if (error) throw friendlyError(error, 'Could not update the semester');
  }

  // ── Mutations ──────────────────────────────────────────────────────────
  async function approveClearance (studentUUID, categoryUUID, signatoryUUID, semester, academicYear) {
    var { error } = await window.supabase.rpc('fn_approve_clearance', {
      p_student_id:    studentUUID,
      p_category_id:   categoryUUID,
      p_signatory_id:  signatoryUUID,
      p_semester:      semester,
      p_academic_year: academicYear
    });
    if (error) throw friendlyError(error, 'Could not approve the clearance');
  }

  async function flagClearance (studentUUID, categoryUUID, signatoryUUID, remarks, semester, academicYear) {
    var { error } = await window.supabase.rpc('fn_flag_clearance', {
      p_student_id:    studentUUID,
      p_category_id:   categoryUUID,
      p_signatory_id:  signatoryUUID,
      p_remarks:       remarks,
      p_semester:      semester,
      p_academic_year: academicYear
    });
    if (error) throw friendlyError(error, 'Could not flag the clearance');
  }

  // ── Automated College President approval ────────────────────────────────
  // Called after any of the first 9 office signatories approves. When ALL 9
  // non-president requirements are now 'cleared' for the student + term, the
  // College President's requirement is automatically set to 'cleared' with
  // signed_at = now(). signed_by stays NULL so the record is identifiable as
  // AUTOMATIC (manual approvals always carry a signer).
  // Re-applies only when all 9 prerequisites are cleared again; a manual
  // Dr. Richel hold is always respected (kept until she acts) and an
  // already-cleared row is never clobbered. Returns { approved: true } when
  // it fired.
  async function autoApprovePresident (studentUUID, semester, academicYear) {
    var presidentCatId = await getPresidentCategoryId();
    if (!presidentCatId) return { approved: false };

    // Read the president's current requirement.
    var cur = await window.supabase
      .from('clearance_records')
      .select('id,status')
      .eq('student_id', studentUUID)
      .eq('semester', semester)
      .eq('academic_year', academicYear)
      .eq('category_id', presidentCatId)
      .maybeSingle();
    if (cur.error) throw friendlyError(cur.error, 'Could not read the College President clearance');

    // Already cleared (auto or manual) or manually held by Dr. Richel: no auto action.
    if (cur.data && (cur.data.status === 'cleared' || cur.data.status === 'hold')) {
      return { approved: false };
    }

    // Count cleared NON-president requirements for this student + term.
    var cnt = await window.supabase
      .from('clearance_records')
      .select('id', { count: 'exact', head: true })
      .eq('student_id', studentUUID)
      .eq('semester', semester)
      .eq('academic_year', academicYear)
      .eq('status', 'cleared')
      .neq('category_id', presidentCatId);
    if (cnt.error) throw friendlyError(cnt.error, 'Could not check the clearance progress');
    if ((cnt.count || 0) < 9) return { approved: false };

    // Upsert the president's requirement to 'cleared' at now() — automated,
    // so signed_by stays NULL to distinguish it from a manual approval.
    var up = await window.supabase
      .from('clearance_records')
      .upsert({
        student_id:    studentUUID,
        category_id:   presidentCatId,
        semester:      semester,
        academic_year: academicYear,
        status:        'cleared',
        remarks:       null,
        signed_at:     new Date().toISOString(),
        signed_by:     null
      }, { onConflict: 'student_id,semester,academic_year,category_id' });
    if (up.error) throw friendlyError(up.error, 'Could not auto-approve the College President');
    return { approved: true };
  }

  // ── Cascading flag / reversal logic ─────────────────────────────────────
  // Called after any of the 9 prerequisite offices flags a student On Hold.
  // Any CLEARED College President approval (automatic OR manual) is reverted
  // to 'pending' so a student can't stay fully approved while a prerequisite
  // office is holding them. It re-applies only once all 9 offices are cleared
  // again. Dr. Richel's own manual HOLD is preserved (kept until she acts);
  // the flagger-is-president case never reaches here (app-side guard).
  async function revertAutoPresidentFlag (studentUUID, semester, academicYear) {
    var presidentCatId = await getPresidentCategoryId();
    if (!presidentCatId) return { reverted: false };

    var cur = await window.supabase
      .from('clearance_records')
      .select('id,status')
      .eq('student_id', studentUUID)
      .eq('semester', semester)
      .eq('academic_year', academicYear)
      .eq('category_id', presidentCatId)
      .maybeSingle();
    if (cur.error) throw friendlyError(cur.error, 'Could not read the College President clearance');

    // Only a CLEARED approval is reverted. A pending or manually-held
    // president requirement is left untouched.
    if (!cur.data || cur.data.status !== 'cleared') return { reverted: false };

    var up = await window.supabase
      .from('clearance_records')
      .update({ status: 'pending', remarks: null, signed_at: null, signed_by: null })
      .eq('id', cur.data.id);
    if (up.error) throw friendlyError(up.error, 'Could not revert the College President approval');
    return { reverted: true };
  }

  // Shared helper: the College President's category UUID (or null).
  async function getPresidentCategoryId () {
    var pc = await window.supabase
      .from('signatory_categories')
      .select('id')
      .eq('key', 'president')
      .maybeSingle();
    if (pc.error) throw friendlyError(pc.error, 'Could not look up the College President office');
    return pc.data ? pc.data.id : null;
  }

  // ── Public API ─────────────────────────────────────────────────────────
  return {
    getCategories:          getCategories,
    loginStudent:           loginStudent,
    loginSignatory:         loginSignatory,
    getStudentClearance:    getStudentClearance,
    hasOutstandingClearance: hasOutstandingClearance,
    getAllStudentClearance:  getAllStudentClearance,
    getSemesterOptions:      getSemesterOptions,
    getStudentsForSemester: getStudentsForSemester,
    updateActiveStudentsSemester: updateActiveStudentsSemester,
    getAllStudents:          getAllStudents,
    updateStudent:          updateStudent,
    assignStudentsYearSection: assignStudentsYearSection,
    createStudent:          createStudent,
    changeStudentPassword:  changeStudentPassword,
    changeSignatoryPassword: changeSignatoryPassword,
    findStudentByInstitutionalId: findStudentByInstitutionalId,
    sendPasswordResetEmail: sendPasswordResetEmail,
    resetPasswordChangeCount: resetPasswordChangeCount,
    initializeClearance:    initializeClearance,
    initNewTerm:            initNewTerm,
    applyRosterUpload:      applyRosterUpload,
    setStudentAcademicStatus: setStudentAcademicStatus,
    approveClearance:       approveClearance,
    flagClearance:          flagClearance,
    autoApprovePresident:   autoApprovePresident,
    revertAutoPresidentFlag: revertAutoPresidentFlag,
    getSemesters:           getSemesters,
    getActiveSemester:      getActiveSemester,
    createSemester:         createSemester,
    activateSemester:       activateSemester,
    updateSemester:         updateSemester
  };
})();