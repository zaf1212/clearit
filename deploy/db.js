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
    var q = window.supabase
      .from('v_clearance_details')
      .select('student_id, institutional_id, student_name, year_block, program, category_key, category_name, signatory_name, status, remarks, signed_at, signed_by_name')
      .order('display_order');
    if (semester) q = q.eq('record_semester', semester);
    if (academicYear) q = q.eq('record_academic_year', academicYear);
    var { data, error } = await q;
    if (error) throw friendlyError(error, 'Could not load student clearances');
    return data || [];
  }

  // ── Students whose semester / A.Y. tags match the SELECTED term ──────────
  // Reads v_student_progress (cohort + progress, filtered by the same semester
  // as the clearance records) so the dashboard always reflects the dropdown.
  // Falls back to the students table if the view isn't installed yet.
  async function getStudentsForSemester (semester, academicYear) {
    try {
      var q = window.supabase
        .from('v_student_progress')
        .select('student_id, institutional_id, full_name, year_block, program')
        .in('enrollment_status', ['Regular', 'Irregular']);
      if (semester) q = q.eq('semester', semester);
      if (academicYear) q = q.eq('academic_year', academicYear);
      var { data, error } = await q;
      if (error) throw friendlyError(error, 'Could not load students for this term');
      return (data || []).map(function (r) {
        return {
          student_id: r.student_id, institutional_id: r.institutional_id,
          full_name: r.full_name, year_block: r.year_block, program: r.program
        };
      });
    } catch (e) {
      var q2 = window.supabase
        .from('students')
        .select('id, institutional_id, full_name, year_block, program')
        .in('enrollment_status', ['Regular', 'Irregular']);
      if (semester) q2 = q2.eq('semester', semester);
      if (academicYear) q2 = q2.eq('academic_year', academicYear);
      var { data, error } = await q2;
      if (error) throw friendlyError(error, 'Could not load students for this term');
      return (data || []).map(function (r) {
        return {
          student_id: r.id, institutional_id: r.institutional_id,
          full_name: r.full_name, year_block: r.year_block, program: r.program
        };
      });
    }
  }

  // ── Stamp ALL ACTIVE students with the newly initialized term ───────────
  // Called right before/after fn_init_clearance so every active (Regular /
  // Irregular) student's semester + academic_year match the new term.
  async function updateActiveStudentsSemester (semester, academicYear) {
    var { error } = await window.supabase
      .from('students')
      .update({ semester: semester, academic_year: academicYear })
      .in('enrollment_status', ['Regular', 'Irregular']);
    if (error) throw friendlyError(error, 'Could not update student semester tags');
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
  async function getAllStudents () {
    try {
      var r1 = await window.supabase
        .from('students')
        .select('id, institutional_id, full_name, email, year_block, program, semester, academic_year, enrollment_status, paid, paid_date, password_change_count')
        .order('institutional_id');
      if (r1.error) throw r1.error;
      return r1.data || [];
    } catch (e) {
      // Graceful degrade if the SQL migration hasn't run yet (column missing).
      var r2 = await window.supabase
        .from('students')
        .select('id, institutional_id, full_name, email, year_block, program, semester, academic_year, enrollment_status, paid, paid_date')
        .order('institutional_id');
      if (r2.error) throw friendlyError(r2.error, 'Could not load the student list');
      return (r2.data || []).map(function (s) {
        s.password_change_count = 0;
        return s;
      });
    }
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

  // ── Forgot Password (login page): account lookup by identifier ──────────
  // No password verification — used only to confirm an account exists before
  // writing a fresh hash. Returns the stable UUID + display info.
  async function findStudentByInstitutionalId (institutionalId) {
    var { data, error } = await window.supabase
      .from('students')
      .select('id, full_name, email, institutional_id, password_change_count')
      .eq('institutional_id', institutionalId)
      .maybeSingle();
    if (error) throw friendlyError(error, 'Could not verify the student account');
    return data || null;
  }

  async function findSignatoryByEmail (email) {
    var { data, error } = await window.supabase
      .from('signatories')
      .select('id, full_name, email, role')
      .eq('email', email)
      .maybeSingle();
    if (error) throw friendlyError(error, 'Could not verify the signatory account');
    return data || null;
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

  // ── Starting a new semester cycle: initialize clearances for ALL ACTIVE students
  async function initializeClearance (semester, academicYear) {
    var { data, error } = await window.supabase.rpc('fn_init_clearance', {
      p_semester:      semester,
      p_academic_year: academicYear
    });
    if (error) throw friendlyError(error, 'Could not initialize clearance records');
    return data || 0;
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
    createStudent:          createStudent,
    changeStudentPassword:  changeStudentPassword,
    changeSignatoryPassword: changeSignatoryPassword,
    findStudentByInstitutionalId: findStudentByInstitutionalId,
    findSignatoryByEmail: findSignatoryByEmail,
    resetPasswordChangeCount: resetPasswordChangeCount,
    initializeClearance:    initializeClearance,
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