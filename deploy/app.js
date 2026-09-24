(function () {
  'use strict';

  /* ===================== Supabase client (global access) ===================== */
  // Credentials mirror supabaseConfig.js (window.__SUPABASE_URL / _ANON_KEY).
  // The client is created ONCE from the ESM import block in index.html and
  // stored on window.supabase — the exact object every db.js/app.js query uses,
  // so auth, clearance RPC calls, and all database fetches share one
  // globally-accessible client.
  //
  // This bootstrap is a Netlify safety net: if the module block ever fails to
  // run (e.g. a stale cached page, blocked external import), the client is
  // re-created right here so the app still connects to the live cloud database.
  var SUPABASE_URL      = window.__SUPABASE_URL || 'https://fnzuzzcyjvfqwrjfhmie.supabase.co';
  var SUPABASE_ANON_KEY = window.__SUPABASE_ANON_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZuenV6emN5anZmcXdyamZobWllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTUxMzUsImV4cCI6MjEwMjY3MTEzNX0.y5VXHKekyI8IpmaQlG2tRVA35whO8qzAcbzrPHhsbzw';

  (function ensureSupabaseClient () {
    // Already created (module block present), or async bootstrap in flight —
    // init() awaits window.__SUPABASE_READY, so never duplicate the client.
    if (window.supabase || (window.__SUPABASE_READY && window.__SUPABASE_READY.then)) return;
    if (!SUPABASE_ANON_KEY) return;

    window.__SUPABASE_READY = import('https://esm.sh/@supabase/supabase-js@2?bundle')
      .then(function (mod) {
        window.supabase = mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        window.sb = window.supabase; // alias kept for older references
        console.log('[CLEARIT] Supabase client ready (app.js bootstrap).');
        return true;
      })
      .catch(function (err) {
        console.error('[CLEARIT] Supabase client bootstrap failed:', err);
        window.__SUPABASE_LOAD_ERROR =
          'Could not connect to the database. Check your internet connection and refresh the page.';
        return false;
      });
  })();

  /* ===================== Constants ===================== */

  var SIG_KEYS   = [];   // derived from DB categories
  var SIG_LABELS = {};   // key → category name
  var SIG_NAMES  = {};   // key → signatory office holder name

  var SIGNATORY_EMAILS = {
    treasury:        'arnel.zafra@tcc.edu.ph',
    campusMinistry:  'riza.archival@tcc.edu.ph',
    discipline:      'mae.abellana@tcc.edu.ph',
    librarian:       'malourdes.mediano@tcc.edu.ph',
    propertyCustodian:'jade.geraldez@tcc.edu.ph',
    studentOrg:      'fritzie.formis@tcc.edu.ph',
    studentAffairs:  'jennilyn.geagonia@tcc.edu.ph',
    registrar:       'wendelyn.labajo@tcc.edu.ph',
    dean:            'glen.tabucanon@tcc.edu.ph',
    president:       'richel.bacaltos@tcc.edu.ph'
  };

  // Student password change limit (self-service). The SAS Director can reset
  // a student's counter back to 0 from Manage Students.
  var PW_MAX = 3;
  var PW_WARNING = 'You have reached the maximum limit of 3 password changes. Please visit the Student Affairs Services (SAS) Office for assistance with resetting your password.';

  /* ===================== Module state ===================== */

  var categories       = [];  // [{ id, key, name, signatory_name }]
  var currentUser      = null; // student or signatory session
  var currentLoginTab  = 'student';
  var forgotRole       = 'student'; // role selected inside the Forgot Password modal
  var remarkTarget     = null;

  var studentClearanceRows = [];
  var allStudentRows       = [];
  var adminStudentList     = [];  // all students for admin panel
  var adminEditTarget      = null; // student UUID being edited

  // Semester Clearance Management (SAS Director) state
  var semesterMgmtList   = [];   // [{ id, semester, academic_year, is_active }]
  var semesterEditTarget = null; // semester entry being edited

  // Semester-based clearance state
  var currentSemester = '2nd Semester';
  var currentAY       = '2025-2026';
  var semesterOptions = [];  // [{ semester, academic_year }]

  // Selected-semester dataset for the signatory dashboard:
  // semesterStudents = active student cohort whose tags match the dropdown
  // allClearanceRows = raw clearance records for the selected term
  var semesterStudents = [];
  var allClearanceRows = [];

  // Prerequisite (previous-semester) clearance state:
  // prevClearanceRows = records for the term BEFORE the selected one
  // blockedStudents   = { student_id: true } when that term has pending/hold
  // studentPrereqBlocked/Msg = student-portal warning state
  var prevClearanceRows = [];
  var blockedStudents = {};
  var studentPrereqBlocked = false;
  var studentPrereqMsg = '';

  var SEMESTER_CHOICES = ['1st Semester', '2nd Semester', 'Summer / Midyear'];

  /* ===================== DOM helpers ===================== */

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function initials(name) {
    return name.split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase();
  }

  function todayStr() {
    return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function catIdFromKey(key) {
    for (var i = 0; i < categories.length; i++) {
      if (categories[i].key === key) return categories[i].id;
    }
    return null;
  }

  /* ===================== Semester helpers ===================== */

  function semesterLabel(sem, ay) {
    return sem + ' - SY ' + ay;
  }

  // Compact "2nd Semester SY 2025-2026" label used in prerequisite messages.
  function termLabel(sem, ay) {
    return sem + ' - SY ' + ay;
  }

  // The term that comes immediately BEFORE the given one.
  // Cycle: 1st Semester → 2nd Semester → Summer / Midyear → (next A.Y.) 1st.
  function prevTerm(sem, ay) {
    var parts = String(ay || '').split('-');
    var s = parseInt(parts[0], 10), e = parseInt(parts[1], 10);
    var shift = (parts.length === 2 && s && e) ? (s - 1) + '-' + (e - 1) : ay;
    if (sem === '2nd Semester')   return { semester: '1st Semester',    academic_year: ay };
    if (sem === 'Summer / Midyear') return { semester: '2nd Semester',   academic_year: ay };
    return { semester: 'Summer / Midyear', academic_year: shift }; // 1st Semester
  }

  function sortSemesterOptions(opts) {
    var order = { '2nd Semester': 0, '1st Semester': 1 };
    opts.sort(function (a, b) {
      if (a.academic_year !== b.academic_year) return a.academic_year < b.academic_year ? 1 : -1;
      var ao = order[a.semester] !== undefined ? order[a.semester] : 2;
      var bo = order[b.semester] !== undefined ? order[b.semester] : 2;
      return ao - bo;
    });
  }

  function ensureSemesterOption(sem, ay) {
    for (var i = 0; i < semesterOptions.length; i++) {
      if (semesterOptions[i].semester === sem && semesterOptions[i].academic_year === ay) return;
    }
    semesterOptions.push({ semester: sem, academic_year: ay });
    sortSemesterOptions(semesterOptions);
  }

  function fillSemesterSelect(sel) {
    sel.innerHTML = '';
    semesterOptions.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.semester + '|' + o.academic_year;
      opt.textContent = semesterLabel(o.semester, o.academic_year);
      sel.appendChild(opt);
    });
  }

  function setSemesterSelection(sem, ay) {
    currentSemester = sem;
    currentAY       = ay;
    var val = sem + '|' + ay;
    $('#sv-semester-select').value  = val;
    $('#sa-semester-select').value  = val;
  }

  function fillAllSemesterSelects() {
    fillSemesterSelect($('#sv-semester-select'));
    fillSemesterSelect($('#sa-semester-select'));
  }

  async function refreshSemesterOptions () {
    semesterOptions = await DB.getSemesterOptions();
    sortSemesterOptions(semesterOptions);
    ensureSemesterOption(currentSemester, currentAY);
    fillAllSemesterSelects();
  }

  // Access control: only the SAS Director (Mrs. Jennilyn D. Geagonia) may
  // create, edit, or activate semesters. All other roles are blocked.
  function isSASDirector () {
    return !!(currentUser &&
      currentUser.type === 'signatory' &&
      currentUser.email === 'jennilyn.geagonia@tcc.edu.ph' &&
      (currentUser.role === 'sas_director' || currentUser.catKey === 'studentAffairs'));
  }

  async function refreshStudentData (silent) {
    if (!silent) $('#loading-overlay').classList.remove('hidden');
    try {
      studentClearanceRows = await DB.getStudentClearance(currentUser.studentUUID, currentSemester, currentAY);

      // Self-heal: if all 9 offices are cleared but the automated president
      // approval has not applied yet (e.g. it was set before this code was
      // loaded), apply it now — respects Dr. Richel's manual hold.
      var clearedCount = 0, presRow = null;
      studentClearanceRows.forEach(function (r) {
        if (r.category_key === 'president') { presRow = r; }
        else if (r.status === 'cleared') { clearedCount++; }
      });
      if (clearedCount >= 9 && presRow && presRow.status === 'pending') {
        await DB.autoApprovePresident(currentUser.studentUUID, currentSemester, currentAY);
        studentClearanceRows = await DB.getStudentClearance(currentUser.studentUUID, currentSemester, currentAY);
      }

      await loadStudentPrereq();
      renderStudent();
    } catch (err) {
      console.error(err);
      toast('Failed to load clearance data: ' + err.message, 'error');
    } finally {
      if (!silent) $('#loading-overlay').classList.add('hidden');
    }
  }

  /* ===================== Real-time (student progress, no page refresh) ===================== */

  // Subscribes the student's dashboard to live changes on their clearance
  // records, so the moment all 9 offices (or the automated president
  // approval) land, the progress view updates to 100% / Cleared instantly.
  // Requires Supabase Realtime to be enabled for clearance_records
  // (see clearit_live_setup.sql); if it isn't, this degrades silently and
  // the manual refresh button still works.
  var rtChannel = null;

  function subscribeStudentRealtime () {
    if (!window.supabase || rtChannel) return;
    if (!currentUser || currentUser.type !== 'student') return;
    rtChannel = window.supabase
      .channel('clearit-student-' + currentUser.studentUUID)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'clearance_records',
        filter: 'student_id=eq.' + currentUser.studentUUID
      }, function () {
        if (currentUser && currentUser.type === 'student') refreshStudentData(true);
      })
      .subscribe();
  }

  function unsubscribeStudentRealtime () {
    if (rtChannel && window.supabase) window.supabase.removeChannel(rtChannel);
    rtChannel = null;
  }

  // Signatory dashboards also stay live: any office signing or flagging a
  // student (including a cascading president reversal) immediately re-renders
  // the table so the President column / Overall Status reflect the change
  // without a page refresh. Requires the clearance_records publication too.
  var rtSignatoryChannel = null;

  function subscribeSignatoryRealtime () {
    if (!window.supabase || rtSignatoryChannel) return;
    if (!currentUser || currentUser.type !== 'signatory') return;
    rtSignatoryChannel = window.supabase
      .channel('clearit-signatory-' + currentUser.signatoryUUID)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'clearance_records'
      }, function () {
        if (currentUser && currentUser.type === 'signatory') refreshSignatoryData();
      })
      .subscribe();
  }

  function unsubscribeSignatoryRealtime () {
    if (rtSignatoryChannel && window.supabase) window.supabase.removeChannel(rtSignatoryChannel);
    rtSignatoryChannel = null;
  }

  /* ===================== Toast ===================== */

  var TOAST_BG = { success: 'bg-emerald-600', info: 'bg-navy-700', error: 'bg-red-600' };
  var TOAST_IC = {
    success: '<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>',
    info:    '<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
    error:   '<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>'
  };

  function toast(msg, type) {
    var bg = TOAST_BG[type] || TOAST_BG.info;
    var ic = TOAST_IC[type] || TOAST_IC.info;
    var el = document.createElement('div');
    el.className = 'toast flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg ' + bg;
    el.innerHTML = ic + '<span>' + msg + '</span>';
    $('#toast-container').appendChild(el);
    setTimeout(function () {
      el.classList.add('toast-out');
      setTimeout(function () { el.remove(); }, 320);
    }, 3400);
  }

  /* ===================== Global error safety net ===================== */

  // Friendly message for a thrown/rejected error (no raw internals leak)
  function errorMessage(err) {
    if (err && err.message) {
      var m = err.message;
      if (m.length > 160) m = m.slice(0, 160) + '\u2026';
      return m;
    }
    return String(err || 'Unexpected error');
  }

  // Catch any unawaited promise rejection so nothing throws uncaught
  window.addEventListener('unhandledrejection', function (e) {
    e.preventDefault();
    console.error('[CLEARIT] Unhandled rejection:', e.reason);
    toast('Something went wrong: ' + errorMessage(e.reason), 'error');
  });

  // Last-resort guard for stray runtime errors
  window.addEventListener('error', function (e) {
    if (e && e.error) console.error('[CLEARIT] Uncaught error:', e.error);
  });

  /* ===================== View switching ===================== */

  function showView(name) {
    $('#login-view').classList.toggle('hidden', name !== 'login');
    $('#student-view').classList.toggle('hidden', name !== 'student');
    $('#signatory-view').classList.toggle('hidden', name !== 'signatory');
    window.scrollTo(0, 0);
  }

  /* ===================== Button loading helpers ===================== */

  function setLoading (btn, loading) {
    if (loading) {
      btn.disabled = true;
      btn.dataset.origText = btn.textContent;
      btn.innerHTML = '<svg class="animate-spin h-4 w-4 inline mr-1" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg> Signing in\u2026';
    } else {
      btn.disabled = false;
      btn.textContent = btn.dataset.origText || 'Sign In';
    }
  }

  /* ===================== Login ===================== */

  function setLoginTab(tab) {
    currentLoginTab = tab;
    $$('.role-tab').forEach(function (btn) {
      btn.classList.toggle('tab-active', btn.getAttribute('data-tab') === tab);
    });
    $('#signatory-role-field').classList.toggle('hidden', tab !== 'signatory');
    if (tab === 'signatory') {
      $('#login-id-label').textContent = 'Institutional Email';
      $('#login-id').placeholder = 'e.g. glen.tabucanon@tcc.edu.ph';
    } else {
      $('#login-id-label').textContent = 'Institutional ID';
      $('#login-id').placeholder = 'e.g. 2023-5548';
    }
    hideLoginError();
  }

  function showLoginError(msg) {
    $('#login-error-msg').textContent = msg;
    $('#login-error').classList.remove('hidden');
  }
  function hideLoginError() { $('#login-error').classList.add('hidden'); }

  async function attemptLogin (tab, id, pass, roleKey) {
    if (!id || !pass) {
      showLoginError('Please enter your Institutional ID/Email and password.');
      return;
    }

    var submitBtn = $('#login-form button[type="submit"]');
    setLoading(submitBtn, true);
    hideLoginError();

    try {
      if (tab === 'student') {
        var res = await DB.loginStudent(id, pass);
        if (!res || !res.ok) {
          showLoginError((res && res.error) || 'Invalid credentials. Try 2023-5548 / password123.');
          return;
        }
        currentUser = {
          type: 'student',
          studentUUID:      res.id,
          name:             res.name,
          email:            res.email,
          iId:              res.i_id,
          block:            res.block,
          program:          res.program,
          semester:         res.semester,
          academicYear:     res.academic_year,
          enrollmentStatus: res.enrollment_status,
          paid:             res.paid,
          paidDate:         res.paid_date,
          passwordChangeCount: res.password_change_count || 0
        };
      } else {
        var res2 = await DB.loginSignatory(id, pass);
        if (!res2 || !res2.ok) {
          showLoginError((res2 && res2.error) || 'Invalid email or password. Try glen.tabucanon@tcc.edu.ph / admin123.');
          return;
        }
        currentUser = {
          type:          'signatory',
          signatoryUUID: res2.id,
          name:          res2.name,
          email:         res2.email,
          catId:         res2.category_id,
          catKey:        res2.category_key,
          catName:       res2.category_name
        };
      }

      persistRemember();
      await enterApp();
    } catch (err) {
      console.error('[CLEARIT] Login error:', err);
      var detail = (err && err.message) ? err.message : String(err);
      if (detail.indexOf('404') !== -1 || detail.indexOf('Not Found') !== -1) {
        showLoginError('Resource not found. The database tables may not exist yet. Run clearit_schema.sql first.');
      } else if (detail.indexOf('fetch') !== -1 || detail.indexOf('network') !== -1 || detail.indexOf('Failed to fetch') !== -1) {
        showLoginError('Cannot reach Supabase. Check your internet connection and try again.');
      } else {
        showLoginError('Error: ' + detail);
      }
    } finally {
      setLoading(submitBtn, false);
    }
  }

  async function enterApp () {
    $('#login-password').value = '';
    hideLoginError();

    // Load available semester options for the dropdown and the "Current Active
    // Semester" system flag (not critical if it fails).
    var activeSem = null;
    try {
      semesterOptions = await DB.getSemesterOptions();
      sortSemesterOptions(semesterOptions);
      activeSem = await DB.getActiveSemester();
    } catch (err) {
      console.error('[CLEARIT] Could not load semester options:', err);
    }

    // Default everyone to the SAS Director's active semester on login.
    var defaultSem = null, defaultAY = null;
    if (activeSem && activeSem.semester && activeSem.academic_year) {
      defaultSem = activeSem.semester;
      defaultAY  = activeSem.academic_year;
    }

    if (currentUser.type === 'student') {
      $('#loading-overlay').classList.remove('hidden');
      try {
        // Default to the active semester, else the student's enrolled semester.
        currentSemester = defaultSem || currentUser.semester || '2nd Semester';
        currentAY       = defaultAY  || currentUser.academicYear || '2025-2026';
        ensureSemesterOption(currentSemester, currentAY);
        fillAllSemesterSelects();
        setSemesterSelection(currentSemester, currentAY);

        studentClearanceRows = await DB.getStudentClearance(currentUser.studentUUID, currentSemester, currentAY);
        await loadStudentPrereq();
        renderStudent();
        subscribeStudentRealtime();
        showView('student');
        toast('Welcome back, ' + currentUser.name.split(' ')[0] + '!', 'success');
      } catch (err) {
        console.error(err);
        toast('Failed to load clearance data: ' + err.message, 'error');
      } finally {
        $('#loading-overlay').classList.add('hidden');
      }
    } else {
      $('#loading-overlay').classList.remove('hidden');
      try {
        // Default signatories to the active semester, else most recent semester.
        currentSemester = defaultSem || (semesterOptions.length ? semesterOptions[0].semester : '2nd Semester');
        currentAY       = defaultAY  || (semesterOptions.length ? semesterOptions[0].academic_year : '2025-2026');
        ensureSemesterOption(currentSemester, currentAY);
        fillAllSemesterSelects();
        setSemesterSelection(currentSemester, currentAY);

        // Dashboard data is filtered BOTH ways by the selected semester:
        // 1) the student cohort (v_student_progress) by semester tags, and
        // 2) the clearance records (v_clearance_details) by record semester.
        allClearanceRows = await DB.getAllStudentClearance(currentSemester, currentAY);
        semesterStudents = await DB.getStudentsForSemester(currentSemester, currentAY);
        await loadPrereqData();
        allStudentRows = buildSemesterStudents();
        renderSignatory();
        subscribeSignatoryRealtime();
        showView('signatory');
        toast('Signed in as ' + currentUser.catName + '.', 'info');

        // RBAC: only the Student Affairs Services Director gets the Manage Students button
        $('#sa-manage-students').classList.toggle('hidden', !isSASDirector());

        // RBAC: only the SAS Director gets Semester Clearance Management
        var isSAS = isSASDirector();
        $('#sa-semester-mgmt').classList.toggle('hidden', !isSAS);
      } catch (err) {
        console.error(err);
        toast('Failed to load student data: ' + err.message, 'error');
      } finally {
        $('#loading-overlay').classList.add('hidden');
      }
    }
  }

  function logout () {
    unsubscribeStudentRealtime();
    unsubscribeSignatoryRealtime();
    currentUser = null;
    studentClearanceRows = [];
    allStudentRows = [];
    semesterStudents = [];
    allClearanceRows = [];
    prevClearanceRows = [];
    blockedStudents = {};
    studentPrereqBlocked = false;
    studentPrereqMsg = '';
    semesterMgmtList = [];
    semesterEditTarget = null;
    $('#sa-manage-students').classList.add('hidden');
    $('#sa-semester-mgmt').classList.add('hidden');
    showView('login');
  }

  /* ===================== Remember me ===================== */

  function persistRemember () {
    try {
      if ($('#remember-me').checked) {
        localStorage.setItem('clearit_remember', JSON.stringify({
          tab:  currentLoginTab,
          id:   $('#login-id').value.trim(),
          pass: $('#login-password').value,
          role: $('#signatory-role').value
        }));
      } else {
        localStorage.removeItem('clearit_remember');
      }
    } catch (e) { /* ignore */ }
  }

  function restoreRemember () {
    try {
      var raw = localStorage.getItem('clearit_remember');
      if (!raw) return;
      var d = JSON.parse(raw);
      setLoginTab(d.tab === 'signatory' ? 'signatory' : 'student');
      $('#login-id').value = d.id || '';
      $('#login-password').value = d.pass || '';
      $('#remember-me').checked = true;
      if (d.role) $('#signatory-role').value = d.role;
    } catch (e) { /* ignore */ }
  }

  /* ===================== Status chips ===================== */

  function chip (status) {
    if (status === 'cleared') {
      return '<span class="chip bg-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-200">' +
        '<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>Cleared</span>';
    }
    if (status === 'hold') {
      return '<span class="chip bg-red-100 text-red-700 ring-1 ring-inset ring-red-200">' +
        '<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>On Hold</span>';
    }
    return '<span class="chip bg-amber-100 text-amber-700 ring-1 ring-inset ring-amber-200">' +
      '<svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>Pending</span>';
  }

  /* ===================== Transform helpers ===================== */

  function buildSignatures (rows) {
    var sigs = {};
    SIG_KEYS.forEach(function (k) {
      sigs[k] = { status: 'pending', remark: '', date: '', signatoryName: SIG_NAMES[k] || '' };
    });
    rows.forEach(function (r) {
      if (sigs[r.category_key] !== undefined) {
        sigs[r.category_key] = {
          status: r.status,
          remark: r.remarks || '',
          date:   r.signed_at ? formatDate(r.signed_at) : '',
          signatoryName: r.signatory_name || SIG_NAMES[r.category_key] || ''
        };
      }
    });
    return sigs;
  }

  function progressOf (sigs) {
    var cleared = 0;
    SIG_KEYS.forEach(function (k) {
      if (sigs[k] && sigs[k].status === 'cleared') cleared++;
    });
    return { pct: Math.round((cleared / SIG_KEYS.length) * 100), cleared: cleared, total: SIG_KEYS.length };
  }

  function overallOf (sigs) {
    var hasHold = false, hasPending = false;
    SIG_KEYS.forEach(function (k) {
      if (sigs[k].status === 'hold')    hasHold = true;
      if (sigs[k].status === 'pending') hasPending = true;
    });
    if (hasHold) return 'hold';
    if (hasPending) return 'pending';
    return 'cleared';
  }

  /* ===================== Student dashboard ===================== */

  function renderStudent () {
    var sigs = buildSignatures(studentClearanceRows);
    var p = progressOf(sigs);
    var name = currentUser.name;

    $('#sv-initials').textContent  = initials(name);
    $('#sv-user-full').textContent = name;
    $('#sd-initials').textContent  = initials(name);
    $('#sd-name').textContent      = name;
    $('#sd-id').textContent        = currentUser.iId;
    $('#sd-block').textContent     = currentUser.block;
    $('#sd-program').textContent   = currentUser.program;

    // Term chips mirror the selected semester dropdown so the view
    // matches the clearance data being shown.
    $('#sd-semester').textContent  = currentSemester || '';
    $('#sd-ay').textContent        = currentAY || '';
    $('#sd-status').textContent    = currentUser.enrollmentStatus || '';

    var paidStamp = $('#sd-paid-stamp');
    if (currentUser.paid) {
      paidStamp.classList.remove('hidden');
      var pd = currentUser.paidDate ? formatDate(currentUser.paidDate) : '';
      paidStamp.title = pd ? 'Paid on ' + pd : 'Paid';
    } else {
      paidStamp.classList.add('hidden');
    }

    $('#sd-percent').textContent     = p.pct;
    $('#sd-percent-big').textContent = p.pct + '%';
    $('#sd-progress-fill').style.width = p.pct + '%';
    $('#sd-progress-text').textContent = p.cleared + ' of ' + p.total + ' requirements signed';

    var overall = overallOf(sigs);
    if (overall === 'cleared') {
      $('#sd-overall-text').textContent = 'Fully cleared \u2014 congratulations!';
      $('#sd-banner-wrap').classList.remove('hidden');
    } else if (overall === 'hold') {
      $('#sd-overall-text').textContent = 'On hold \u2014 action required';
      $('#sd-banner-wrap').classList.add('hidden');
    } else {
      $('#sd-overall-text').textContent = 'In progress';
      $('#sd-banner-wrap').classList.add('hidden');
    }

    var counts = { cleared: 0, pending: 0, hold: 0 };
    SIG_KEYS.forEach(function (k) { counts[sigs[k].status]++; });
    $('#sd-legend').innerHTML =
      '<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>Cleared: <b>' + counts.cleared + '</b></span>' +
      '<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-amber-500"></span>Pending: <b>' + counts.pending + '</b></span>' +
      '<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-full bg-red-500"></span>On Hold: <b>' + counts.hold + '</b></span>';

    var rows = '';
    SIG_KEYS.forEach(function (k, idx) {
      var d = sigs[k];
      var remark = d.remark
        ? '<span class="text-slate-600">' + d.remark + '</span>'
        : '<span class="text-slate-300">&mdash;</span>';
      rows +=
        '<tr class="hover:bg-slate-50 transition">' +
        '<td class="px-6 py-3.5 text-slate-400 text-xs font-semibold">' + (idx + 1) + '</td>' +
        '<td class="px-4 py-3.5 font-semibold text-slate-700">' + SIG_LABELS[k] + '</td>' +
        '<td class="px-4 py-3.5 text-xs text-slate-500">' + d.signatoryName + '</td>' +
        '<td class="px-4 py-3.5">' + chip(d.status) + '</td>' +
        '<td class="px-4 py-3.5 text-xs text-slate-500">' + (d.date || '<span class="text-slate-300">&mdash;</span>') + '</td>' +
        '<td class="px-6 py-3.5 text-xs max-w-xs">' + remark + '</td>' +
        '</tr>';
    });
    $('#sd-table-body').innerHTML = rows;

    // Student portal prereq notice: previous semester must be resolved first.
    $('#sv-prereq-banner').classList.toggle('hidden', !studentPrereqBlocked);
    if (studentPrereqBlocked) {
      $('#sv-prereq-text').textContent = studentPrereqMsg;
    }

    var done = p.pct === 100;
    var blockedSem = studentPrereqBlocked;
    $('#sd-download-btn').disabled = blockedSem;
    $('#sd-download-btn').textContent = done ? 'Download Official Clearance PDF' : 'Print Clearance (Unofficial Draft)';
    if (blockedSem) {
      $('#sd-download-hint').textContent = 'Cannot download: ' + termLabel(currentSemester, currentAY) + ' clearance is blocked until your previous semester obligations are resolved.';
    } else if (done) {
      $('#sd-download-hint').textContent = 'All requirements cleared. The official clearance printout includes the Validation Seal, QR verification, and Control Number.';
    } else {
      $('#sd-download-hint').textContent = 'You may print an UNOFFICIAL draft now \u2014 it is marked "PENDING APPROVAL". The Official Seal, QR verification, and Control Number appear only after all 10 requirements are cleared (' + (100 - p.pct) + '% remaining).';
    }
  }

  /* ===================== Signatory dashboard ===================== */

  // Build the signatory dashboard dataset by merging the SELECTED semester's
  // student cohort with that semester's clearance records. Students whose tags
  // match the selected term but have no records yet (brand-new term) still show
  // with all-pending statuses; clearance rows whose student tags don't match
  // yet are appended so no record ever disappears.
  function buildSemesterStudents () {
    var map = {};
    function seed (id, iId, name, block, program) {
      if (map[id]) return;
      map[id] = { uuid: id, iId: iId, name: name, block: block, program: program, sigs: {} };
      SIG_KEYS.forEach(function (k) {
        map[id].sigs[k] = { status: 'pending', remark: '', date: '', signatoryName: SIG_NAMES[k] || '' };
      });
    }
    semesterStudents.forEach(function (s) {
      seed(s.student_id, s.institutional_id, s.full_name, s.year_block, s.program);
    });
    allClearanceRows.forEach(function (r) {
      seed(r.student_id, r.institutional_id, r.student_name, r.year_block, r.program);
      var sig = map[r.student_id].sigs[r.category_key];
      if (sig) {
        sig.status = r.status;
        sig.remark = r.remarks || '';
        sig.date   = r.signed_at ? formatDate(r.signed_at) : '';
        sig.signatoryName = r.signatory_name || SIG_NAMES[r.category_key] || '';
      }
    });
    return Object.values(map);
  }

  function renderSignatory () {
    var key = currentUser.catKey;
    var q   = $('#sa-search').value.trim().toLowerCase();
    var blk = $('#sa-block-filter').value;

    // True when the selected semester has clearance records at all.
    var hasRecords = allClearanceRows.length > 0;

    var students = buildSemesterStudents();

    // Stats
    var total = students.length, cleared = 0, hold = 0, pending = 0;
    students.forEach(function (st) {
      var o = overallOf(st.sigs);
      if (o === 'cleared') cleared++;
      else if (o === 'hold') hold++;
      else pending++;
    });
    $('#sa-total').textContent   = total;
    $('#sa-cleared').textContent = cleared;
    $('#sa-pending').textContent = pending;
    $('#sa-hold').textContent    = hold;

    $('#sa-role-badge').textContent = currentUser.catName;
    $('#sa-user-email').textContent = currentUser.email;
    $('#sa-active-col').textContent = currentUser.catName;

    // Block filter dropdown
    var blockSet = {};
    students.forEach(function (st) { blockSet[st.block] = true; });
    var sel = $('#sa-block-filter');
    var curVal = sel.value;
    sel.innerHTML = '<option value="">All Year / Block</option>';
    Object.keys(blockSet).sort().forEach(function (b) {
      var o = document.createElement('option');
      o.value = b; o.textContent = b;
      sel.appendChild(o);
    });
    if (curVal) sel.value = curVal;

    // Filter
    var filtered = students.filter(function (st) {
      var okBlk = !blk || st.block === blk;
      var okQ   = !q || st.name.toLowerCase().indexOf(q) !== -1 || st.iId.toLowerCase().indexOf(q) !== -1;
      return okBlk && okQ;
    });

    $('#sa-count').textContent = filtered.length;

    // Rows
    var prev = prevTerm(currentSemester, currentAY);
    var anyBlocked = false;
    var rows = '';
    filtered.forEach(function (st) {
      var sigCells = '';
      SIG_KEYS.forEach(function (sk) {
        var active = sk === key ? ' active-col' : '';
        var d = st.sigs[sk];
        sigCells += '<td class="px-2 py-3.5 text-center' + active + '">' + chip(d.status) + '</td>';
      });

      var p = progressOf(st.sigs);
      var pctColor = p.pct === 100 ? 'bg-emerald-500' : 'bg-navy-600';
      var overallCell =
        '<td class="px-3 py-3.5 min-w-[100px]">' +
        '<div class="flex items-center gap-2">' +
        '<div class="flex-1 h-1.5 rounded-full bg-slate-100 overflow-hidden"><div class="progress-fill h-full rounded-full ' + pctColor + '" style="width:' + p.pct + '%"></div></div>' +
        '<span class="text-xs font-bold text-slate-600 w-9 text-right">' + p.pct + '%</span>' +
        '</div></td>';

      var own = st.sigs[key];

      // Prerequisite block: outstanding (pending/hold) clearance from the term
      // before the selected one ⇒ student is Blocked / Ineligible this term.
      var blocked = !!blockedStudents[st.uuid];
      if (blocked) anyBlocked = true;
      var prevTermLabel = termLabel(prev.semester, prev.academic_year);
      var blockedNote = 'Cannot proceed with clearance for ' + termLabel(currentSemester, currentAY) +
        ' due to pending or incomplete clearance from ' + prevTermLabel + '.';

      var notesCell = blocked
        ? '<td class="px-3 py-3.5 text-xs text-red-600 max-w-[200px] break-words" title="' + blockedNote.replace(/"/g, '&quot;') + '">' +
          '<span class="font-bold">Blocked:</span> ' + blockedNote.slice(0, 70) + '\u2026</td>'
        : (own.remark
            ? '<td class="px-3 py-3.5 text-xs text-slate-600 max-w-[140px] truncate" title="' + own.remark.replace(/"/g, '&quot;') + '">' + own.remark + '</td>'
            : '<td class="px-3 py-3.5 text-xs text-slate-300">&mdash;</td>');

      var approved = own.status === 'cleared';
      var approveDisabled = approved || blocked;
      var approveClass = blocked
        ? 'bg-slate-200 text-slate-500 cursor-not-allowed'
        : approved
          ? 'bg-emerald-50 text-emerald-400 cursor-not-allowed'
          : 'bg-emerald-600 text-white shadow-sm shadow-emerald-600/20 hover:bg-emerald-700';
      var approveLabel = blocked ? 'Blocked' : (approved ? 'Signed' : 'Approve');
      var approveTitle = blocked
        ? 'Cannot approve: ' + prevTermLabel + ' clearance must be resolved first.'
        : '';
      var actions =
        '<td class="px-4 py-3.5 text-right whitespace-nowrap">' +
        '<button data-action="approve" data-student-uuid="' + st.uuid + '" data-student-name="' + st.name.replace(/"/g, '&quot;') + '" data-student-iid="' + st.iId + '" ' +
          (approveDisabled ? 'disabled ' : '') +
          (approveTitle ? 'title="' + approveTitle + '" ' : '') +
          'class="rounded-lg px-3 py-1.5 text-xs font-bold mr-2 transition ' + approveClass + '">' +
          approveLabel + '</button>' +
        '<button data-action="flag" data-student-uuid="' + st.uuid + '" data-student-name="' + st.name.replace(/"/g, '&quot;') + '" data-student-iid="' + st.iId + '" ' +
          'class="rounded-lg px-3 py-1.5 text-xs font-bold border transition ' +
          (own.status === 'hold' ? 'bg-red-600 border-red-600 text-white hover:bg-red-700' : 'border-red-200 text-red-600 hover:bg-red-50') + '">' +
          (own.status === 'hold' ? 'Update' : 'Flag') + '</button>' +
        '</td>';

      rows +=
        '<tr class="hover:bg-slate-50/60 transition">' +
        '<td class="px-4 py-3.5"><div class="font-semibold text-slate-700">' + st.name + '</div><div class="text-xs text-slate-400 font-mono mt-0.5">' + st.iId + '</div>' +
        (blocked ? '<div class="mt-1.5"><span class="chip bg-red-100 text-red-700 ring-1 ring-inset ring-red-200">Blocked / Ineligible</span></div>' : '') +
        '</td>' +
        '<td class="px-2 py-3.5"><span class="chip bg-navy-50 text-navy-700 ring-1 ring-inset ring-navy-100">' + st.block + '</span></td>' +
        sigCells + overallCell + notesCell + actions +
        '</tr>';
    });

    $('#sa-table-body').innerHTML = rows;

    // Prerequisite banner (visible to all signatories): students with
    // outstanding clearance from the previous semester can't be cleared yet.
    $('#sa-prereq-banner').classList.toggle('hidden', !anyBlocked);
    if (anyBlocked) {
      var nBlocked = Object.keys(blockedStudents).length;
      $('#sa-prereq-banner-text').innerHTML =
        '<b>' + nBlocked + (nBlocked === 1 ? ' student' : ' students') + '</b> still have pending or incomplete clearance from <b>' +
        termLabel(prev.semester, prev.academic_year) + '</b>. They cannot be cleared for <b>' +
        termLabel(currentSemester, currentAY) +
        '</b> until their previous semester obligations are resolved \u2014 <b>Approve is disabled</b> for them.';
    }

    // SAS Director: when the SELECTED semester has zero records, offer the
    // one-click "Initialize Clearances for this Term" prompt.
    var canInitBanner = !hasRecords && isSASDirector();
    $('#sa-init-banner').classList.toggle('hidden', !canInitBanner);
    if (canInitBanner) {
      $('#sa-init-banner-term').textContent = 'Term: ' + semesterLabel(currentSemester, currentAY) +
        '. Initialize to generate 10 pending records per active student.';
    }

    // Dynamic empty state (SAS gets init guidance, everyone else filter help).
    if (filtered.length === 0) {
      if (canInitBanner) {
        $('#sa-empty').innerHTML =
          '<p class="text-sm font-semibold text-slate-500">No clearance records yet for ' +
          semesterLabel(currentSemester, currentAY) + '.</p>' +
          '<p class="text-xs text-slate-400 mt-1">Click \u201cInitialize Clearances for this Term\u201d above to generate 10 pending records per active student.</p>';
      } else {
        $('#sa-empty').innerHTML =
          '<p class="text-sm font-semibold text-slate-500">No students match your filters.</p>' +
          '<p class="text-xs text-slate-400 mt-1">Try a different search term or clear the Year/Block filter.</p>';
      }
    }
    $('#sa-empty').classList.toggle('hidden', filtered.length > 0);

    // Highlight active column header
    $$('th[data-sig-col]').forEach(function (th) {
      th.classList.toggle('active-col', th.getAttribute('data-sig-col') === key);
    });
  }

  /* ===================== Remark modal ===================== */

  function openRemarkModal (uuid, name, iId) {
    remarkTarget = { uuid: uuid, name: name, iId: iId };
    $('#remark-title').textContent = name + ' \u2014 ' + iId;
    $('#remark-sub').textContent   = currentUser.catName + ' \u2014 placing on hold';

    var existing = '';
    for (var i = 0; i < allStudentRows.length; i++) {
      var st = allStudentRows[i];
      var mine = st.sigs && st.sigs[currentUser.catKey];
      if (st.uuid === uuid && mine && mine.remark) {
        existing = mine.remark; break;
      }
    }
    $('#remark-textarea').value = existing;
    $('#remark-error').classList.add('hidden');
    $('#remark-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('#remark-textarea').focus();
  }

  function closeRemarkModal () {
    remarkTarget = null;
    $('#remark-modal').classList.add('hidden');
    document.body.style.overflow = '';
  }

  /* ===================== Admin Student Management modal ===================== */

  function openAdminModal () {
    // Defense-in-depth: only the SAS Director may open Student Management,
    // even if the hidden button were somehow triggered by another role.
    if (!isSASDirector()) {
      toast('Access denied. Only the Student Affairs Services Director can manage students.', 'error');
      return;
    }
    $('#admin-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('#admin-list-panel').classList.remove('hidden');
    $('#admin-edit-panel').classList.add('hidden');
    $('#admin-register-panel').classList.add('hidden');
    adminEditTarget = null;
    setSemesterSelection(currentSemester, currentAY);
    loadAdminStudentList();
    $('#admin-search').value = '';
    $('#admin-search').focus();
  }

  function closeAdminModal () {
    $('#admin-modal').classList.add('hidden');
    document.body.style.overflow = '';
    adminEditTarget = null;
  }

  async function loadAdminStudentList () {
    try {
      adminStudentList = await DB.getAllStudents();
    } catch (err) {
      console.error(err);
      toast('Failed to load student list: ' + err.message, 'error');
      return;
    }
    renderAdminList();
  }

  function pwChip (s) {
    var used = s.password_change_count || 0;
    var cls = used >= PW_MAX
      ? 'bg-red-100 text-red-700 ring-1 ring-inset ring-red-200'
      : (used > 0 ? 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200' : 'bg-slate-50 text-slate-500 ring-1 ring-inset ring-slate-200');
    return '<span class="chip ' + cls + '" title="Used ' + used + ' of ' + PW_MAX + ' self-service password changes">' + used + '/' + PW_MAX + '</span>';
  }

  function renderAdminList () {
    var q = ($('#admin-search').value || '').trim().toLowerCase();
    var filtered = adminStudentList.filter(function (s) {
      return !q ||
        s.full_name.toLowerCase().indexOf(q) !== -1 ||
        s.institutional_id.toLowerCase().indexOf(q) !== -1 ||
        s.email.toLowerCase().indexOf(q) !== -1;
    });

    var tbody = $('#admin-student-list');
    var rows = '';
    filtered.forEach(function (s) {
      rows +=
        '<tr class="hover:bg-slate-50 transition">' +
        '<td class="py-3 font-mono text-xs text-slate-600">' + s.institutional_id + '</td>' +
        '<td class="py-3 font-semibold text-slate-700">' + s.full_name + '</td>' +
        '<td class="py-3 text-xs text-slate-500">' + s.email + '</td>' +
        '<td class="py-3"><span class="chip bg-navy-50 text-navy-700 ring-1 ring-inset ring-navy-100">' + s.year_block + '</span></td>' +
        '<td class="py-3 text-center">' + pwChip(s) + '</td>' +
        '<td class="py-3 text-right">' +
          '<button data-admin-edit="' + s.id + '" class="rounded-lg px-3 py-1.5 text-xs font-bold bg-navy-50 text-navy-700 border border-navy-200 hover:bg-navy-100 transition">Edit</button>' +
        '</td>' +
        '</tr>';
    });
    tbody.innerHTML = rows;
    $('#admin-list-empty').classList.toggle('hidden', filtered.length > 0);
  }

  function openAdminEdit (studentUUID) {
    var student = null;
    for (var i = 0; i < adminStudentList.length; i++) {
      if (adminStudentList[i].id === studentUUID) { student = adminStudentList[i]; break; }
    }
    if (!student) { toast('Student not found.', 'error'); return; }

    adminEditTarget = student;
    $('#admin-edit-id').value = student.id;
    $('#admin-edit-name').value = student.full_name;
    $('#admin-edit-iid').value = student.institutional_id;
    $('#admin-edit-email').value = student.email || '';
    $('#admin-edit-block').value = student.year_block || '';
    $('#admin-edit-program').value = student.program || '';
    $('#admin-edit-semester').value = student.semester || '';
    $('#admin-edit-ay').value = student.academic_year || '';
    $('#admin-edit-status').value = student.enrollment_status || 'Regular';
    $('#admin-edit-password').value = '';
    $('#admin-edit-pw-count').textContent = student.password_change_count || 0;
    $('#admin-reset-pw-count').disabled = (student.password_change_count || 0) === 0;
    $('#admin-edit-subtitle').textContent = student.institutional_id;
    $('#admin-edit-error').classList.add('hidden');

    $('#admin-list-panel').classList.add('hidden');
    $('#admin-edit-panel').classList.remove('hidden');
  }

  function closeAdminEdit () {
    $('#admin-list-panel').classList.remove('hidden');
    $('#admin-edit-panel').classList.add('hidden');
    adminEditTarget = null;
  }

  // SAS Director override: reset a student's password change counter to 0.
  async function resetAdminPasswordCount () {
    if (!adminEditTarget) return;
    var btn = $('#admin-reset-pw-count');
    btn.disabled = true;
    btn.textContent = 'Resetting\u2026';
    try {
      await DB.resetPasswordChangeCount(adminEditTarget.id);
      adminEditTarget.password_change_count = 0;
      $('#admin-edit-pw-count').textContent = '0';
      btn.disabled = true;
      btn.textContent = 'Reset Password Limit';
      toast('Password change limit reset to 0. The student can change their password again.', 'success');
    } catch (err) {
      console.error(err);
      btn.disabled = false;
      btn.textContent = 'Reset Password Limit';
      toast('Reset failed: ' + ((err && err.message) || String(err)), 'error');
    }
  }

  async function saveAdminEdit () {
    if (!adminEditTarget) return;

    var name    = $('#admin-edit-name').value.trim();
    var iid     = $('#admin-edit-iid').value.trim();
    var email   = $('#admin-edit-email').value.trim();
    var block   = $('#admin-edit-block').value.trim();
    var program = $('#admin-edit-program').value.trim();
    var sem     = $('#admin-edit-semester').value.trim();
    var ay      = $('#admin-edit-ay').value.trim();
    var status  = $('#admin-edit-status').value;
    var newPass = $('#admin-edit-password').value;

    if (!name || !iid) {
      $('#admin-edit-error').textContent = 'Full Name and Institutional ID are required.';
      $('#admin-edit-error').classList.remove('hidden');
      return;
    }

    var fields = {
      full_name:         name,
      institutional_id:  iid,
      email:             email,
      year_block:        block,
      program:           program,
      semester:          sem,
      academic_year:     ay,
      enrollment_status: status
    };

    if (newPass) {
      fields.password_hash = window.bcrypt.hashSync(newPass, 10);
      // SAS resetting the password also resets the student's change limit.
      fields.password_change_count = 0;
    }

    var saveBtn = $('#admin-edit-save');
    setLoading(saveBtn, true);
    $('#admin-edit-error').classList.add('hidden');

    try {
      await DB.updateStudent(adminEditTarget.id, fields);
      toast('Student updated successfully!', 'success');
      closeAdminEdit();
      await loadAdminStudentList();
    } catch (err) {
      console.error(err);
      var detail = (err && err.message) ? err.message : String(err);
      if (detail.indexOf('23505') !== -1) {
        $('#admin-edit-error').textContent = 'That Student ID or Email already exists for another student.';
      } else {
        $('#admin-edit-error').textContent = 'Update failed: ' + detail;
      }
      $('#admin-edit-error').classList.remove('hidden');
    } finally {
      setLoading(saveBtn, false);
    }
  }

  /* ===================== Admin: Register New Student ===================== */

  function openAdminRegister () {
    $('#admin-list-panel').classList.add('hidden');
    $('#admin-edit-panel').classList.add('hidden');
    $('#admin-register-panel').classList.remove('hidden');

    $('#reg-name').value = '';
    $('#reg-iid').value = '';
    $('#reg-email').value = '';
    $('#reg-program').value = 'BSINDTECH-COMPTECH';
    $('#reg-block').value = '1st Year / Charity';
    $('#reg-semester').value = '2nd Semester';
    $('#reg-ay').value = '2025-2026';
    $('#reg-status').value = 'Regular';
    $('#reg-password').value = '123456';
    $('#admin-register-error').classList.add('hidden');
    $('#reg-name').focus();
  }

  function closeAdminRegister () {
    $('#admin-register-panel').classList.add('hidden');
    $('#admin-list-panel').classList.remove('hidden');
  }

  async function submitAdminRegister () {
    var name    = $('#reg-name').value.trim();
    var iid     = $('#reg-iid').value.trim();
    var email   = $('#reg-email').value.trim();
    var program = $('#reg-program').value;
    var block   = $('#reg-block').value;
    var sem     = $('#reg-semester').value;
    var ay      = $('#reg-ay').value.trim();
    var status  = $('#reg-status').value;
    var pass    = $('#reg-password').value;

    if (!name || !iid) {
      $('#admin-register-error').textContent = 'Full Name and Institutional ID are required.';
      $('#admin-register-error').classList.remove('hidden');
      return;
    }
    if (!pass) {
      $('#admin-register-error').textContent = 'An initial password is required.';
      $('#admin-register-error').classList.remove('hidden');
      return;
    }

    var hash = window.bcrypt.hashSync(pass, 10);

    var fields = {
      full_name:         name,
      institutional_id:  iid,
      email:             email || (name.toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9.]/g, '') + '@tcc.edu.ph'),
      password_hash:     hash,
      year_block:        block,
      program:           program,
      semester:          sem,
      academic_year:     ay,
      enrollment_status: status,
      paid:              false
    };

    var saveBtn = $('#admin-register-submit');
    setLoading(saveBtn, true);
    $('#admin-register-error').classList.add('hidden');

    try {
      await DB.createStudent(fields);
      toast('Student successfully registered and clearance sheet initialized!', 'success');
      closeAdminRegister();
      await loadAdminStudentList();
    } catch (err) {
      console.error(err);
      var detail = (err && err.message) ? err.message : String(err);
      if (detail.indexOf('23505') !== -1) {
        $('#admin-register-error').textContent = 'That Student ID or Email already exists.';
      } else {
        $('#admin-register-error').textContent = 'Registration failed: ' + detail;
      }
      $('#admin-register-error').classList.remove('hidden');
    } finally {
      setLoading(saveBtn, false);
    }
  }

  /* ===================== Semester Clearance Management (SAS Director only) ===================== */

  function openSemesterMgmtModal () {
    if (!isSASDirector()) {
      toast('Access denied. Only the SAS Director can manage semesters.', 'error');
      return;
    }
    $('#semester-mgmt-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('#sm-main-panel').classList.remove('hidden');
    $('#sm-edit-panel').classList.add('hidden');
    semesterEditTarget = null;
    $('#sm-ay').value = suggestNextAY();
    $('#sm-semester').value = '1st Semester';
    $('#sm-error').classList.add('hidden');
    loadSemesterMgmtList();
  }

  function closeSemesterMgmtModal () {
    $('#semester-mgmt-modal').classList.add('hidden');
    document.body.style.overflow = '';
    semesterEditTarget = null;
  }

  function suggestNextAY () {
    var parts = (currentAY || '2025-2026').split('-');
    if (parts.length === 2 && parseInt(parts[1], 10)) {
      return parts[0] + '-' + (parseInt(parts[1], 10) + 1);
    }
    return '2026-2027';
  }

  async function loadSemesterMgmtList () {
    try {
      semesterMgmtList = await DB.getSemesters();
    } catch (err) {
      console.error(err);
      toast('Failed to load semesters: ' + err.message, 'error');
      return;
    }
    renderSemesterMgmtList();
  }

  function renderSemesterMgmtList () {
    var sorted = semesterMgmtList.slice().sort(function (a, b) {
      if (!!a.is_active !== !!b.is_active) return a.is_active ? -1 : 1;
      if (a.academic_year !== b.academic_year) return a.academic_year < b.academic_year ? 1 : -1;
      if (a.semester !== b.semester) return a.semester < b.semester ? -1 : 1;
      return 0;
    });

    var rows = '';
    sorted.forEach(function (s) {
      var status = s.is_active
        ? '<span class="chip bg-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-200">Active</span>'
        : '<span class="chip bg-slate-100 text-slate-500 ring-1 ring-inset ring-slate-200">Created</span>';
      var setActiveBtn = s.is_active
        ? '<button disabled class="rounded-lg px-3 py-1.5 text-xs font-bold mr-2 bg-emerald-50 text-emerald-400 cursor-not-allowed">Active</button>'
        : '<button data-sm-activate="' + s.id + '" class="rounded-lg px-3 py-1.5 text-xs font-bold mr-2 bg-navy-700 text-white shadow-sm shadow-navy-700/20 hover:bg-navy-800 transition">Set Active</button>';
      rows +=
        '<tr class="hover:bg-slate-50 transition">' +
        '<td class="py-3 font-mono text-xs text-slate-600">' + s.academic_year + '</td>' +
        '<td class="py-3 font-semibold text-slate-700">' + s.semester + '</td>' +
        '<td class="py-3">' + status + '</td>' +
        '<td class="py-3 text-right whitespace-nowrap">' + setActiveBtn +
        '<button data-sm-edit="' + s.id + '" class="rounded-lg px-3 py-1.5 text-xs font-bold bg-navy-50 text-navy-700 border border-navy-200 hover:bg-navy-100 transition">Edit</button>' +
        '</td>' +
        '</tr>';
    });
    $('#sm-semester-list').innerHTML = rows;
    $('#sm-empty').classList.toggle('hidden', sorted.length > 0);
  }

  // Create / Initialize New Semester: upsert the semester row, then generate 10
  // 'pending' clearance records per ACTIVE student for that (sem, A.Y.).
  async function submitCreateSemester () {
    if (!isSASDirector()) { toast('Access denied.', 'error'); return; }

    var ay  = $('#sm-ay').value.trim();
    var sem = $('#sm-semester').value;
    if (!/^\d{4}-\d{4}$/.test(ay)) {
      $('#sm-error').textContent = 'Academic Year must be in YYYY-YYYY format, e.g. 2026-2027.';
      $('#sm-error').classList.remove('hidden');
      return;
    }

    var btn = $('#sm-init-btn');
    setLoading(btn, true);
    $('#sm-error').classList.add('hidden');

    try {
      await DB.createSemester(sem, ay, currentUser.email);
      // Stamp all active students to the new term, then generate clearances.
      await DB.updateActiveStudentsSemester(sem, ay);
      var count = await DB.initializeClearance(sem, ay);
      ensureSemesterOption(sem, ay);
      await refreshSemesterOptions();
      fillAllSemesterSelects();
      setSemesterSelection(sem, ay);
      await loadSemesterMgmtList();
      // Refresh whichever dashboard is currently on screen so the newly
      // initialized term shows immediately.
      if (currentUser.type === 'student') await refreshStudentData();
      else await refreshSignatoryData();
      toast('Semester ' + semesterLabel(sem, ay) + ' created. Updated student semester tags and initialized ' +
            (count || 0) + ' pending clearance record(s) for active students.', 'success');
    } catch (err) {
      console.error(err);
      $('#sm-error').textContent = err.message;
      $('#sm-error').classList.remove('hidden');
    } finally {
      setLoading(btn, false);
    }
  }

  // Set the "Current Active Semester" system flag — becomes the login default.
  async function setActiveSemester (semesterId) {
    if (!isSASDirector()) { toast('Access denied.', 'error'); return; }

    var target = null;
    for (var i = 0; i < semesterMgmtList.length; i++) {
      if (semesterMgmtList[i].id === semesterId) { target = semesterMgmtList[i]; break; }
    }
    if (!target) { toast('Semester not found.', 'error'); return; }

    var btn = $('button[data-sm-activate="' + semesterId + '"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '\u2026';
    }
    try {
      await DB.activateSemester(semesterId, currentUser.email);
      // Switching terms: stamp active students + auto-initialize clearances
      // for the newly activated semester (duplicates are skipped by the RPC).
      await DB.updateActiveStudentsSemester(target.semester, target.academic_year);
      var count = await DB.initializeClearance(target.semester, target.academic_year);
      currentSemester = target.semester;
      currentAY        = target.academic_year;
      ensureSemesterOption(currentSemester, currentAY);
      fillAllSemesterSelects();
      setSemesterSelection(currentSemester, currentAY);
      await loadSemesterMgmtList();
      // Reflect the new active term on the visible dashboard immediately.
      if (currentUser.type === 'student') await refreshStudentData();
      else await refreshSignatoryData();
      toast('Active semester set to ' + semesterLabel(currentSemester, currentAY) + '.' +
            (count ? ' Initialized ' + count + ' pending clearance record(s).' : ''), 'success');
    } catch (err) {
      console.error(err);
      toast('Failed to set active semester: ' + err.message, 'error');
      await loadSemesterMgmtList();
    }
  }

  function fillSemesterEditSelect () {
    var sel = $('#sm-edit-semester');
    sel.innerHTML = '';
    SEMESTER_CHOICES.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s;
      o.textContent = s;
      sel.appendChild(o);
    });
  }

  function openSemesterEdit (semesterId) {
    if (!isSASDirector()) { toast('Access denied.', 'error'); return; }

    var target = null;
    for (var i = 0; i < semesterMgmtList.length; i++) {
      if (semesterMgmtList[i].id === semesterId) { target = semesterMgmtList[i]; break; }
    }
    if (!target) { toast('Semester not found.', 'error'); return; }

    semesterEditTarget = target;
    fillSemesterEditSelect();
    $('#sm-edit-semester').value = target.semester;
    $('#sm-edit-ay').value = target.academic_year;
    $('#sm-edit-subtitle').textContent = target.is_active ? 'Active semester' : 'Created semester';
    $('#sm-edit-error').classList.add('hidden');
    $('#sm-main-panel').classList.add('hidden');
    $('#sm-edit-panel').classList.remove('hidden');
  }

  function closeSemesterEdit () {
    $('#sm-main-panel').classList.remove('hidden');
    $('#sm-edit-panel').classList.add('hidden');
    semesterEditTarget = null;
  }

  async function saveSemesterEdit () {
    if (!isSASDirector() || !semesterEditTarget) { toast('Access denied.', 'error'); return; }

    var ay  = $('#sm-edit-ay').value.trim();
    var sem = $('#sm-edit-semester').value;
    if (!/^\d{4}-\d{4}$/.test(ay)) {
      $('#sm-edit-error').textContent = 'Academic Year must be in YYYY-YYYY format, e.g. 2026-2027.';
      $('#sm-edit-error').classList.remove('hidden');
      return;
    }

    var btn = $('#sm-edit-save');
    setLoading(btn, true);
    $('#sm-edit-error').classList.add('hidden');

    try {
      await DB.updateSemester(semesterEditTarget.id, sem, ay, currentUser.email);
      if (semesterEditTarget.is_active) {
        currentSemester = sem;
        currentAY        = ay;
        ensureSemesterOption(sem, ay);
      }
      await refreshSemesterOptions();
      fillAllSemesterSelects();
      setSemesterSelection(currentSemester, currentAY);
      await loadSemesterMgmtList();
      closeSemesterEdit();
      toast('Semester updated successfully!', 'success');
    } catch (err) {
      console.error(err);
      $('#sm-edit-error').textContent = err.message;
      $('#sm-edit-error').classList.remove('hidden');
    } finally {
      setLoading(btn, false);
    }
  }

  // One-click "Initialize Clearances for this Term" (SAS Director only).
  // Stamps every active student's semester tags to the selected term, then
  // generates 10 pending clearance records per active student via fn_init_clearance.
  async function initializeSelectedTerm () {
    if (!isSASDirector()) { toast('Access denied.', 'error'); return; }

    var btn = $('#sa-init-term-btn');
    var origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Initializing\u2026';

    try {
      await DB.updateActiveStudentsSemester(currentSemester, currentAY);
      var count = await DB.initializeClearance(currentSemester, currentAY);
      await refreshSignatoryData();
      toast('Initialized ' + (count || 0) + ' pending clearance record(s) for ' +
        semesterLabel(currentSemester, currentAY) + '.', 'success');
    } catch (err) {
      console.error(err);
      toast('Initialization failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  /* ===================== Clearance PDF ===================== */

  function downloadClearance () {
    if (!currentUser || currentUser.type !== 'student') return;
    if (studentPrereqBlocked) {
      toast(studentPrereqMsg || 'Previous semester clearance must be resolved first.', 'error');
      return;
    }
    var sigs = buildSignatures(studentClearanceRows);
    var p = progressOf(sigs);
    var allCleared = p.pct === 100;

    // Verification payload: Control Number + formatted, human-readable
    // OFFICIAL VERIFICATION message, URL-encoded for the QR API.
    // Only built when the clearance is 100% complete across all requirements —
    // pending/on-hold records never get an "OFFICIALLY CLEARED" QR payload.
    var ctrlNumber, qrPayload;
    if (allCleared) {
      var stuName = currentUser.name || 'Student';
      var stuId   = String(currentUser.iId || 'N/A').trim();
      var sem     = currentUser.semester || '2nd Semester';
      var ay      = currentUser.academicYear || '2025-2026';
      var ctrl    = 'CTRL-TCC-' + stuId;
      var verifyUrl = window.location.origin; // https://clearit-tcc.netlify.app in production

      var qrText =
        'OFFICIAL VERIFICATION \u2014 CLEARIT SYSTEM (Talisay City College)\n' +
        'Student Name: ' + stuName + '\n' +
        'Student ID: ' + stuId + '\n' +
        'Status: OFFICIALLY CLEARED\n' +
        'Term: ' + sem + ' - SY ' + ay + '\n' +
        'Control No: ' + ctrl + '\n' +
        'Verification URL: ' + verifyUrl;

      ctrlNumber = ctrl;
      qrPayload  = encodeURIComponent(qrText);
    }

    // Official Digital Seal (circular SVG, double ring) — rendered only when
    // all 10 requirements are cleared.
    var sealSVG =
      '<svg class="digiseal" viewBox="0 0 140 140" width="132" height="132" role="img" aria-label="Talisay City College Official Clearance Validated Seal">' +
      '<defs>' +
      '<path id="sealTop" d="M 16,70 A 54,54 0 0 1 124,70" />' +
      '<path id="sealBot" d="M 16,70 A 54,54 0 0 0 124,70" />' +
      '</defs>' +
      '<circle cx="70" cy="70" r="65" fill="#f0fdf4" stroke="#047857" stroke-width="3.5"/>' +
      '<circle cx="70" cy="70" r="55" fill="none" stroke="#047857" stroke-width="1.6"/>' +
      '<circle cx="70" cy="70" r="38" fill="#ffffff" stroke="#047857" stroke-width="1.2"/>' +
      '<text font-size="9" font-weight="800" fill="#047857" letter-spacing="1.4">' +
      '<textPath href="#sealTop" startOffset="50%" text-anchor="middle">TALISAY CITY COLLEGE</textPath></text>' +
      '<text font-size="7" font-weight="700" fill="#047857" letter-spacing="0.9">' +
      '<textPath href="#sealBot" startOffset="50%" text-anchor="middle">OFFICIAL CLEARANCE VALIDATED</textPath></text>' +
      '<path d="M 57,66 l 10,10 l 22,-26" fill="none" stroke="#047857" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<text x="70" y="92" text-anchor="middle" font-size="8.5" font-weight="800" fill="#047857" letter-spacing="1.1">OFFICIALLY</text>' +
      '<text x="70" y="101" text-anchor="middle" font-size="8.5" font-weight="800" fill="#047857" letter-spacing="1.1">CLEARED</text>' +
      '</svg>';

    var verifyZone = allCleared
      ? '<div class="verify-zone">' +
          '<div class="seal-box">' + sealSVG + '</div>' +
          '<div class="verify-side">' +
            '<div class="seal">&#10003;&nbsp;&nbsp;VERIFIED &mdash; ALL CLEARANCE REQUIREMENTS SIGNED</div>' +
            '<div class="qr-wrap">' +
              '<img id="clear-qr" class="qr" src="https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=' + qrPayload + '" alt="Verification QR code" />' +
              '<div class="ctrl">' + ctrlNumber + '</div>' +
            '</div>' +
          '</div>' +
        '</div>'
      : '<div class="stamp-unofficial">UNOFFICIAL &mdash; PENDING APPROVAL</div>' +
        '<div class="unofficial-note">This clearance is <b>NOT</b> officially validated. The Official Seal, QR verification code, and Control Number appear only after <b>all 10 requirements are cleared</b>. Complete the pending signatories listed above before submitting this form.</div>';

    var htmlRows = '';
    SIG_KEYS.forEach(function (k) {
      var d = sigs[k];
      var check = d.status === 'cleared' ? '&#10003;' : '&mdash;';
      var text  = d.status === 'cleared' ? 'Cleared' : d.status === 'hold' ? 'On Hold' : 'Pending';
      var date  = d.date || '&mdash;';
      var signatoryDisplay = SIG_LABELS[k];
      if (d.signatoryName) signatoryDisplay += ' \u2014 ' + d.signatoryName;
      htmlRows += '<tr><td>' + signatoryDisplay + '</td><td style="text-align:center">' + check + '</td><td style="text-align:center">' + text + '</td><td style="text-align:center">' + date + '</td></tr>';
    });

    var paidHTML = currentUser.paid
      ? '<div style="position:absolute;top:18px;right:18px;border:3px solid #047857;color:#047857;font-weight:800;font-size:18px;padding:6px 18px;transform:rotate(-12deg);letter-spacing:.08em;">PAID</div>'
      : '';

    var html =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Clearance \u2014 ' + currentUser.name + '</title>' +
      '<style>' +
      'body{font-family:Segoe UI,Arial,sans-serif;color:#0f172a;margin:0;padding:40px;}' +
      '.sheet{max-width:740px;margin:0 auto;border:3px solid #1E3A8A;padding:40px;border-radius:8px;position:relative;}' +
      '.head{text-align:center;border-bottom:2px solid #1E3A8A;padding-bottom:16px;margin-bottom:26px;}' +
      '.school{font-size:11px;letter-spacing:.22em;color:#1E3A8A;font-weight:700;}' +
      'h1{margin:6px 0 2px;font-size:24px;letter-spacing:.06em;}' +
      '.sub{color:#334155;font-size:13px;}' +
      '.info{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:22px;font-size:13px;}' +
      '.info b{display:block;font-size:10px;text-transform:uppercase;color:#64748b;letter-spacing:.08em;}' +
      'table{width:100%;border-collapse:collapse;font-size:12.5px;}' +
      'th,td{border:1px solid #cbd5e1;padding:8px 10px;text-align:left;}' +
      'th{background:#eff4fb;color:#1E3A8A;font-size:11px;text-transform:uppercase;letter-spacing:.05em;}' +
      '.verify-zone{display:flex;align-items:center;justify-content:center;gap:30px;margin:26px 0 6px;}' +
      '.seal-box{flex:0 0 auto;}' +
      '.digiseal{display:block;}' +
      '.verify-side{display:flex;flex-direction:column;align-items:center;gap:10px;}' +
      '.seal{text-align:center;color:#047857;font-weight:700;font-size:13px;}' +
      '.qr-wrap{display:flex;flex-direction:column;align-items:center;gap:6px;border:1.5px dashed #047857;border-radius:8px;padding:10px 14px;background:#f8fafc;}' +
      '.qr{width:104px;height:104px;}' +
      '.ctrl{font-size:10.5px;font-weight:800;color:#0f172a;letter-spacing:.05em;}' +
      '.stamp-unofficial{position:absolute;top:44%;left:50%;transform:translate(-50%,-50%) rotate(-14deg);border:3px solid #b91c1c;color:#b91c1c;font-weight:800;font-size:20px;letter-spacing:.12em;padding:10px 30px;border-radius:6px;opacity:.9;background:rgba(255,255,255,.55);z-index:5;text-align:center;white-space:nowrap;}' +
      '.unofficial-note{margin:22px auto 0;max-width:560px;text-align:center;color:#b91c1c;font-weight:600;font-size:11.5px;border:1.5px solid #fecaca;background:#fef2f2;padding:10px 14px;border-radius:8px;}' +
      '@page{size:A4;margin:12mm;}' +
      '@media print{' +
      'body{padding:0;}' +
      '.sheet{max-width:100%;border-radius:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}' +
      '.verify-zone,.seal-box,.verify-side,.qr-wrap,.digiseal,.seal,.unofficial-note,.sigs,.sig,.footer{page-break-inside:avoid;break-inside:avoid;}' +
      'tr{page-break-inside:avoid;break-inside:avoid;}' +
      '.footer{page-break-before:auto;}' +
      '}' +
      '.sigs{display:grid;grid-template-columns:repeat(3,1fr);gap:14px 18px;margin-top:44px;}' +
      '.sig{text-align:center;font-size:11px;color:#334155;}' +
      '.sig .name{font-weight:700;color:#0f172a;font-size:11.5px;min-height:17px;line-height:1.3;margin-bottom:6px;}' +
      '.sig .line{border-top:1px solid #334155;}' +
      '.sig .role{color:#475569;margin-top:5px;line-height:1.3;}' +
      '.sig.president{grid-column:1/-1;margin-top:20px;}' +
      '.sig.president .name{font-size:12px;}' +
      '.sig.president .role{font-weight:600;color:#0f172a;}' +
      '.footer{margin-top:30px;padding-top:14px;border-top:1px solid #cbd5e1;}' +
      '.footer .reminder{color:#b91c1c;font-weight:700;font-size:11px;text-align:center;}' +
      '.foot{margin-top:14px;text-align:center;font-size:10px;color:#64748b;}' +
      '</style></head><body><div class="sheet">' +
      paidHTML +
      '<div class="head"><div class="school">TALISAY CITY COLLEGE</div><h1>CLEARANCE FORM</h1>' +
      '<div class="sub">College of Information Technology &mdash; CLEARIT</div></div>' +
      '<div class="info">' +
      '<div><b>Student Name</b>' + currentUser.name + '</div>' +
      '<div><b>Student ID</b>' + currentUser.iId + '</div>' +
      '<div><b>Program</b>' + currentUser.program + '</div>' +
      '<div><b>Year &amp; Section</b>' + currentUser.block + '</div>' +
      '<div><b>Semester</b>' + (currentUser.semester || '2nd Semester') + '</div>' +
      '<div><b>Academic Year</b>SY ' + (currentUser.academicYear || '2025-2026') + '</div>' +
      '<div><b>Status</b>' + (currentUser.enrollmentStatus || 'Regular') + '</div>' +
      '</div>' +
      '<table><tr><th>Signatory</th><th style="text-align:center">Signature</th><th style="text-align:center">Status</th><th style="text-align:center">Date Signed</th></tr>' + htmlRows + '</table>' +
      verifyZone +
      '<div class="sigs">' +
      SIG_KEYS.filter(function (k) { return k !== 'president'; }).map(function (k) {
        var d = sigs[k];
        var nameTxt = (d.status === 'cleared' && d.signatoryName) ? d.signatoryName : '';
        return '<div class="sig">' +
          '<div class="name">' + (nameTxt || '&nbsp;') + '</div>' +
          '<div class="line"></div>' +
          '<div class="role">' + SIG_LABELS[k] + '</div>' +
          '</div>';
      }).join('') +
      '<div class="sig president">' +
        '<div class="name">' + ((sigs.president && sigs.president.status === 'cleared' && sigs.president.signatoryName) ? sigs.president.signatoryName : '&nbsp;') + '</div>' +
        '<div class="line"></div>' +
        '<div class="role">' + (SIG_LABELS.president || 'College President (Final Approval)') + '</div>' +
      '</div>' +
      '</div>' +
      '<div class="footer"><p class="reminder">IMPORTANT REMINDER: Kindly present this accomplished Clearance Form to the Admission Committee upon enrollment.</p></div>' +
      '<div class="foot">Generated by CLEARIT &middot; ' + todayStr() + '</div>' +
      '</div></body></html>';

    var w = window.open('', '_blank', 'width=840,height=980');
    if (!w) { toast('Pop-up blocked. Allow pop-ups to download the clearance.', 'error'); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
    var printed = false;
    function doPrint () {
      if (printed) return;
      printed = true;
      w.print();
    }
    var qrImg = w.document.getElementById('clear-qr');
    if (qrImg && !qrImg.complete) {
      qrImg.onload = function () { setTimeout(doPrint, 150); };
      setTimeout(doPrint, 2500); // fallback if the QR image is slow/offline
    } else {
      setTimeout(doPrint, 300);
    }
    toast(allCleared
      ? 'Opening official clearance for printing (seal + QR + control number included).'
      : 'Opening UNOFFICIAL clearance draft. The seal, QR, and control number appear once all requirements are cleared.',
      allCleared ? 'success' : 'info');
  }

  /* ===================== Change Password (role-based) ===================== */
  // Students are capped at PW_MAX self-service changes (counter enforced).
  // Signatories and SAS Directors (role 'signatory' / 'sas_director') change
  // their password anytime — counter bypassed, never incremented.

  function pwRemaining () {
    if (!currentUser || currentUser.type !== 'student') return 0;
    return Math.max(0, PW_MAX - ((currentUser.passwordChangeCount || 0)));
  }

  function isPwLimited () {
    return currentUser && currentUser.type === 'student';
  }

  function openPasswordModal () {
    if (!currentUser) return;
    $('#pw-new').value = '';
    $('#pw-confirm').value = '';
    $('#pw-error').classList.add('hidden');
    if (isPwLimited()) {
      var remaining = pwRemaining();
      $('#pw-count-text').textContent = 'Password changes remaining: ' + remaining + ' of ' + PW_MAX;
      var blocked = remaining <= 0;
      $('#pw-warning').classList.toggle('hidden', !blocked);
      if (blocked) $('#pw-warning').textContent = PW_WARNING;
      $('#pw-save').disabled = blocked;
    } else {
      $('#pw-count-text').textContent = 'Unlimited password changes (signatory / admin account)';
      $('#pw-warning').classList.add('hidden');
      $('#pw-save').disabled = false;
    }
    $('#password-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (!$('#pw-save').disabled) $('#pw-new').focus();
  }

  function closePasswordModal () {
    $('#password-modal').classList.add('hidden');
    document.body.style.overflow = '';
  }

  /* ===================== Forgot Password (login page) ===================== */
  // Secure recovery: the public login page never writes new passwords.
  // Students identify their account and receive a Supabase email recovery
  // link/code (supabase.auth.resetPasswordForEmail); signatory/admin resets
  // are intentionally restricted to the SAS Director / System Administrator.

  function openForgotModal () {
    setForgotRole(currentLoginTab === 'signatory' ? 'signatory' : 'student');
    showForgotForm();
    $('#forgot-error').classList.add('hidden');
    $('#forgot-id').value = '';
    $('#forgot-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    setTimeout(function () { if (forgotRole === 'student') $('#forgot-id').focus(); }, 60);
  }

  function closeForgotModal () {
    $('#forgot-modal').classList.add('hidden');
    document.body.style.overflow = '';
  }

  function showForgotForm () {
    $('#forgot-form').classList.remove('hidden');
    $('#forgot-confirmation').classList.add('hidden');
  }

  function showForgotConfirmation () {
    $('#forgot-form').classList.add('hidden');
    $('#forgot-confirmation').classList.remove('hidden');
  }

  function setForgotRole (role) {
    forgotRole = role;
    $$('.forgot-tab').forEach(function (btn) {
      btn.classList.toggle('tab-active', btn.getAttribute('data-role') === role);
    });
    $('#forgot-error').classList.add('hidden');
    if (role === 'signatory') {
      // Signatory / Admin: self-service reset blocked — show the restriction only.
      $('#forgot-student-fields').classList.add('hidden');
      $('#forgot-signatory-block').classList.remove('hidden');
      $('#forgot-submit').disabled = true;
    } else {
      $('#forgot-student-fields').classList.remove('hidden');
      $('#forgot-signatory-block').classList.add('hidden');
      $('#forgot-submit').disabled = false;
      $('#forgot-id-label').textContent = 'Institutional ID';
      $('#forgot-id').placeholder = 'e.g. 2023-5548';
      $('#forgot-id-hint').textContent = 'Enter your Student ID (or TCC email). A verification code / link will be sent to your official TCC email address.';
    }
  }

  // Latest recovery target so "Resend Link" re-triggers the same email.
  var lastForgotEmail = null;

  async function submitForgotRequest () {
    if (forgotRole !== 'student') return; // signatory self-reset is blocked in the UI
    var identifier = $('#forgot-id').value.trim();
    var errEl      = $('#forgot-error');

    errEl.classList.add('hidden');
    if (!identifier) {
      errEl.textContent = 'Please enter your Student ID or institutional email.';
      errEl.classList.remove('hidden');
      return;
    }

    var btn = $('#forgot-submit');
    var orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending\u2026';
    try {
      // Resolve the official TCC email: accept a direct email, or map a
      // Student ID to the email on file.
      var email = identifier.indexOf('@') !== -1 ? identifier : null;
      if (!email) {
        var st = await DB.findStudentByInstitutionalId(identifier);
        if (st && st.email) email = st.email;
      }
      if (email) {
        lastForgotEmail = email;
        await DB.sendPasswordResetEmail(email);
      } else {
        lastForgotEmail = null;
      }
      // Always show the confirmation view — the page never reveals whether
      // the account exists (prevents ID / email enumeration).
      showForgotConfirmation();
    } catch (err) {
      console.error(err);
      errEl.textContent = ((err && err.message) || String(err));
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  async function resendForgotRequest () {
    if (!lastForgotEmail) { showForgotForm(); return; }
    var btn = $('#forgot-resend');
    var orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending\u2026';
    try {
      await DB.sendPasswordResetEmail(lastForgotEmail);
      toast('A new verification link has been sent to your TCC email.', 'success');
    } catch (err) {
      console.error(err);
      toast(((err && err.message) || String(err)), 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  /* ===================== Student Help & FAQ modal ===================== */
  // Floating "Need Help? / FAQ" button (Student Portal only) opens an
  // accordion modal with common clearance questions + direct SAS contact.

  function openFaqItem (item) {
    item.classList.add('open');
    var ans = item.querySelector('.faq-answer');
    if (ans) ans.style.maxHeight = ans.scrollHeight + 'px';
    var q = item.querySelector('.faq-q');
    if (q) q.setAttribute('aria-expanded', 'true');
    var chev = item.querySelector('.faq-chevron');
    if (chev) chev.classList.add('rotate-180');
  }

  function closeFaqItem (item) {
    item.classList.remove('open');
    var ans = item.querySelector('.faq-answer');
    if (ans) ans.style.maxHeight = '';
    var q = item.querySelector('.faq-q');
    if (q) q.setAttribute('aria-expanded', 'false');
    var chev = item.querySelector('.faq-chevron');
    if (chev) chev.classList.remove('rotate-180');
  }

  function openFaqModal () {
    $('#faq-modal').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeFaqModal () {
    $('#faq-modal').classList.add('hidden');
    document.body.style.overflow = '';
    // Collapse any open items so the modal always reopens fresh.
    $('#faq-accordion').querySelectorAll('.faq-item.open').forEach(closeFaqItem);
  }

  async function submitPasswordChange () {
    if (!currentUser) return;
    var limited = isPwLimited();
    if (limited && pwRemaining() <= 0) {
      toast(PW_WARNING, 'error');
      return;
    }
    var newPass  = $('#pw-new').value;
    var confirm  = $('#pw-confirm').value;
    var errEl    = $('#pw-error');
    if (!newPass)      { errEl.textContent = 'Please enter a new password.';      errEl.classList.remove('hidden'); return; }
    if (newPass.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; errEl.classList.remove('hidden'); return; }
    if (newPass !== confirm) { errEl.textContent = 'Passwords do not match.'; errEl.classList.remove('hidden'); return; }
    errEl.classList.add('hidden');

    var btn = $('#pw-save');
    var orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving\u2026';
    try {
      var hash = window.bcrypt.hashSync(newPass, 10);
      if (limited) {
        // Student: enforce the 3-change cap and increment the counter.
        var newCount = (currentUser.passwordChangeCount || 0) + 1;
        await DB.changeStudentPassword(currentUser.studentUUID, hash, newCount);
        currentUser.passwordChangeCount = newCount;
        closePasswordModal();
        toast('Password changed successfully! Remaining changes: ' + pwRemaining() + ' of ' + PW_MAX + '.', 'success');
      } else {
        // Signatory / Admin: bypass the counter, never increment.
        await DB.changeSignatoryPassword(currentUser.signatoryUUID, hash);
        closePasswordModal();
        toast('Password changed successfully! You can change it again anytime.', 'success');
      }
    } catch (err) {
      console.error(err);
      errEl.textContent = 'Failed to change password: ' + ((err && err.message) || String(err));
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = limited && pwRemaining() <= 0;
      btn.textContent = orig;
    }
  }

  /* ===================== Refresh helpers (after mutations) ===================== */

  // Load the term before the selected one and mark students with outstanding
  // (pending/hold) clearance there — they are blocked for the selected term.
  async function loadPrereqData () {
    var prev = prevTerm(currentSemester, currentAY);
    prevClearanceRows = await DB.getAllStudentClearance(prev.semester, prev.academic_year);
    blockedStudents = {};
    prevClearanceRows.forEach(function (r) {
      if ((r.status === 'pending' || r.status === 'hold') && !blockedStudents[r.student_id]) {
        blockedStudents[r.student_id] = true;
      }
    });
  }

  // Student portal: warn when the student still owes the previous semester.
  async function loadStudentPrereq () {
    var prev = prevTerm(currentSemester, currentAY);
    var outstanding = await DB.hasOutstandingClearance(currentUser.studentUUID, prev.semester, prev.academic_year);
    studentPrereqBlocked = outstanding;
    studentPrereqMsg = outstanding
      ? 'Cannot proceed with clearance for ' + termLabel(currentSemester, currentAY) +
        ' due to pending or incomplete clearance from ' + termLabel(prev.semester, prev.academic_year) +
        '. Please resolve your outstanding balance and clearance with the signatories before they can sign off on your new requirements.'
      : '';
  }

  // Self-healing safety net: (re)applies the automated College President
  // approval for any student whose 9 prerequisite offices are ALL cleared
  // while the president's requirement is still pending. Dr. Richel's manual
  // hold is respected (the DB function skips it). Runs on every dashboard
  // refresh, so a missed approval-time trigger can never leave a student
  // stuck at 9/10.
  async function runAutoApproveReconciliation () {
    var touched = 0;
    if (!currentUser || currentUser.type !== 'signatory') return touched;
    var targets = [];
    allStudentRows.forEach(function (st) {
      var cleared = 0;
      for (var i = 0; i < SIG_KEYS.length; i++) {
        var sk = SIG_KEYS[i];
        if (sk === 'president') continue;
        if (st.sigs[sk] && st.sigs[sk].status === 'cleared') cleared++;
      }
      if (cleared >= 9) targets.push(st.uuid);
    });
    for (var j = 0; j < targets.length; j++) {
      try {
        var res = await DB.autoApprovePresident(targets[j], currentSemester, currentAY);
        if (res && res.approved) touched++;
      } catch (err) {
        console.error('Auto president approval (reconciliation) failed for ' + targets[j], err);
      }
    }
    return touched;
  }

  async function refreshSignatoryData () {
    allClearanceRows = await DB.getAllStudentClearance(currentSemester, currentAY);
    semesterStudents = await DB.getStudentsForSemester(currentSemester, currentAY);
    await loadPrereqData();
    allStudentRows = buildSemesterStudents();
    // Self-heal any missed automated president approval, then re-read.
    if (await runAutoApproveReconciliation() > 0) {
      allClearanceRows = await DB.getAllStudentClearance(currentSemester, currentAY);
      await loadPrereqData();
      allStudentRows = buildSemesterStudents();
    }
    renderSignatory();
  }

  /* ===================== Events ===================== */

  async function init () {
    // 1) Await the Supabase ESM client before running any queries.
    //    This prevents "Could not connect" errors on slow networks where the
    //    async module import finishes after DOMContentLoaded.
    if (window.__SUPABASE_READY && window.__SUPABASE_READY.then) {
      var dbReady = await window.__SUPABASE_READY;
      if (!dbReady) {
        toast(window.__SUPABASE_LOAD_ERROR || 'Could not connect to the database. Please refresh.', 'error');
        return;
      }
    } else if (!window.supabase) {
      toast('Could not load the database client. Please open this site in a modern browser and refresh.', 'error');
      return;
    }

    // Load categories from Supabase
    try {
      categories = await DB.getCategories();
    } catch (err) {
      console.error('[CLEARIT] Failed to load categories:', err);
      if (!window.__SUPABASE_LOAD_ERROR) {
        toast('Could not connect to the database. Please refresh.', 'error');
      }
    }

    // Derive SIG_KEYS, SIG_LABELS, SIG_NAMES from DB
    SIG_KEYS   = categories.map(function (c) { return c.key; });
    SIG_LABELS = {};
    SIG_NAMES  = {};
    categories.forEach(function (c) {
      SIG_LABELS[c.key] = c.name;
      SIG_NAMES[c.key]  = c.signatory_name || '';
    });

    // Populate signatory role select
    var sel = $('#signatory-role');
    categories.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.key;
      o.textContent = c.name;
      sel.appendChild(o);
    });

    // Build signatory table headers dynamically
    var theadRow = $('#sa-thead-row');
    if (theadRow) {
      var hdr = '<th class="px-4 py-3 font-semibold min-w-[170px]">Student</th>' +
                '<th class="px-2 py-3 font-semibold">Year / Block</th>';
      categories.forEach(function (c) {
        hdr += '<th class="px-2 py-3 font-semibold text-center" data-sig-col="' + c.key + '">' + c.name.replace('Student Conduct & Discipline Officer','Discipline').replace('Campus Ministry In-charge','Campus Min.').replace('Student Organization Coordinator','Org Coord.').replace('Student Affairs Services Director','SAO Dir.').replace('College President (Final Approval)','President').replace('Treasury In-charge','Treasury').replace('College Librarian','Librarian').replace('College Property Custodian','Property').replace('Program Dean','Dean').replace('College Registrar','Registrar') + '</th>';
      });
      hdr += '<th class="px-3 py-3 font-semibold min-w-[100px]">Overall</th>' +
             '<th class="px-3 py-3 font-semibold min-w-[140px]">My Notes</th>' +
             '<th class="px-4 py-3 font-semibold text-right">Actions</th>';
      theadRow.innerHTML = hdr;
    }

    // Login form
    $('#login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      attemptLogin(currentLoginTab, $('#login-id').value.trim(), $('#login-password').value, $('#signatory-role').value);
    });

    $$('.role-tab').forEach(function (btn) {
      btn.addEventListener('click', function () { setLoginTab(btn.getAttribute('data-tab')); });
    });

    $('#pw-toggle').addEventListener('click', function () {
      var inp = $('#login-password');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    $('#forgot-link').addEventListener('click', openForgotModal);
    $('#forgot-close').addEventListener('click', closeForgotModal);
    $('#forgot-backdrop').addEventListener('click', closeForgotModal);
    $$('.forgot-tab').forEach(function (btn) {
      btn.addEventListener('click', function () { setForgotRole(btn.getAttribute('data-role')); });
    });
    $('#forgot-form').addEventListener('submit', function (e) {
      e.preventDefault();
      submitForgotRequest();
    });
    $('#forgot-resend').addEventListener('click', resendForgotRequest);
    $('#forgot-done').addEventListener('click', closeForgotModal);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#forgot-modal').classList.contains('hidden')) closeForgotModal();
    });

    // Demo buttons
    $('#demo-student-btn').addEventListener('click', function () {
      setLoginTab('student');
      $('#login-id').value = '2023-5548';
      $('#login-password').value = 'password123';
      attemptLogin('student', '2023-5548', 'password123', '');
    });

    $('#demo-signatory-btn').addEventListener('click', function () {
      setLoginTab('signatory');
      $('#signatory-role').value = 'dean';
      $('#login-id').value = 'glen.tabucanon@tcc.edu.ph';
      $('#login-password').value = 'admin123';
      attemptLogin('signatory', 'glen.tabucanon@tcc.edu.ph', 'admin123', 'dean');
    });

    $('#demo-sas-btn').addEventListener('click', function () {
      setLoginTab('signatory');
      $('#signatory-role').value = 'studentAffairs';
      $('#login-id').value = 'jennilyn.geagonia@tcc.edu.ph';
      $('#login-password').value = 'admin123';
      attemptLogin('signatory', 'jennilyn.geagonia@tcc.edu.ph', 'admin123', 'studentAffairs');
    });

    // Auto-fill email when signatory role is selected
    $('#signatory-role').addEventListener('change', function () {
      var key = this.value;
      var email = SIGNATORY_EMAILS[key] || '';
      if (email) {
        $('#login-id').value = email;
        $('#login-id').focus();
      }
    });

    // Logout & refresh
    $('#sv-logout').addEventListener('click', logout);
    $('#sa-logout').addEventListener('click', logout);

    // Change password (role-based: students capped at 3, signatories/admins unlimited)
    $('#sv-change-pw').addEventListener('click', openPasswordModal);
    $('#sa-change-pw').addEventListener('click', openPasswordModal);
    $('#pw-close').addEventListener('click', closePasswordModal);
    $('#pw-cancel').addEventListener('click', closePasswordModal);
    $('#pw-backdrop').addEventListener('click', closePasswordModal);
    $('#pw-form').addEventListener('submit', function (e) {
      e.preventDefault();
      submitPasswordChange();
    });

    // Student Help & FAQ modal
    $('#sv-help-btn').addEventListener('click', openFaqModal);
    $('#faq-close').addEventListener('click', closeFaqModal);
    $('#faq-backdrop').addEventListener('click', closeFaqModal);
    $('#faq-accordion').addEventListener('click', function (e) {
      var q = e.target.closest('.faq-q');
      if (!q) return;
      var item = q.closest('.faq-item');
      if (!item) return;
      var wasOpen = item.classList.contains('open');
      this.querySelectorAll('.faq-item.open').forEach(closeFaqItem); // accordion: one open at a time
      if (!wasOpen) openFaqItem(item);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('#faq-modal').classList.contains('hidden')) closeFaqModal();
      else if (!$('#password-modal').classList.contains('hidden')) closePasswordModal();
    });
    $('#sv-reset').addEventListener('click', async function () {
      toast('Refreshing data from database\u2026', 'info');
      await refreshStudentData();
    });
    $('#sa-reset').addEventListener('click', async function () {
      toast('Refreshing data from database\u2026', 'info');
      await refreshSignatoryData();
    });

    // Student download
    $('#sd-download-btn').addEventListener('click', downloadClearance);

    // Signatory search & filter
    var filterTimer = null;
    $('#sa-search').addEventListener('input', function () {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(function () {
        if (currentUser && currentUser.type === 'signatory') renderSignatory();
      }, 150);
    });
    $('#sa-block-filter').addEventListener('change', function () {
      if (currentUser && currentUser.type === 'signatory') renderSignatory();
    });

    // Signatory table actions (delegated)
    $('#sa-table-body').addEventListener('click', async function (e) {
      var btn = e.target.closest('button[data-action]');
      if (!btn || !currentUser || currentUser.type !== 'signatory') return;

      var studentUUID = btn.dataset.studentUuid;
      var studentName = btn.dataset.studentName;
      var studentIId  = btn.dataset.studentIid;
      var catUUID     = catIdFromKey(currentUser.catKey);
      var sigUUID     = currentUser.signatoryUUID;

      if (!catUUID || !sigUUID) {
        toast('Missing signatory metadata. Please re-login.', 'error');
        return;
      }

      if (btn.dataset.action === 'approve') {
        // Guard: never approve a student with outstanding previous-semester
        // clearance, even if the button state is somehow bypassed.
        if (blockedStudents[studentUUID]) {
          toast('Cannot approve: previous semester clearance must be resolved first.', 'error');
          await refreshSignatoryData();
          return;
        }
        btn.disabled = true;
        btn.textContent = '\u2026';
        try {
          await DB.approveClearance(studentUUID, catUUID, sigUUID, currentSemester, currentAY);

          // Automated president approval: when this sign-off completes all 9
          // non-president requirements, the College President is cleared too
          // (signed_at = now()). Never runs for the president's own approval.
          if (currentUser.catKey !== 'president') {
            try {
              var auto = await DB.autoApprovePresident(studentUUID, currentSemester, currentAY);
              if (auto && auto.approved) {
                toast(studentName + ' has all 9 office requirements \u2014 College President automatically approved.', 'success');
              }
            } catch (autoErr) {
              console.error(autoErr);
              toast('Note: automatic president approval failed (' + autoErr.message + '). The College President can still approve manually.', 'info');
            }
          }

          toast('Cleared: ' + studentName + ' \u2014 ' + currentUser.catName + ' signed.', 'success');
          await refreshSignatoryData();
        } catch (err) {
          console.error(err);
          toast('Approval failed: ' + err.message, 'error');
          await refreshSignatoryData();
        }
      } else {
        openRemarkModal(studentUUID, studentName, studentIId);
      }
    });

    // Remark modal
    $('#remark-cancel').addEventListener('click', closeRemarkModal);
    $('#remark-close').addEventListener('click', closeRemarkModal);
    $('#remark-backdrop').addEventListener('click', closeRemarkModal);

    $('#remark-save').addEventListener('click', async function () {
      if (!remarkTarget) return;
      var txt = $('#remark-textarea').value.trim();
      if (!txt) { $('#remark-error').classList.remove('hidden'); return; }

      var catUUID  = catIdFromKey(currentUser.catKey);
      var sigUUID  = currentUser.signatoryUUID;
      var saveBtn  = $('#remark-save');
      setLoading(saveBtn, true);

      try {
        var flaggedName = remarkTarget.name;
        await DB.flagClearance(remarkTarget.uuid, catUUID, sigUUID, txt, currentSemester, currentAY);

        // Cascading reversal: flagging from any of the 9 prerequisite offices
        // revokes a CLEARED College President approval (automatic or manual).
        // It re-applies only after all 9 prerequisites are cleared again.
        // Dr. Richel's own manual HOLD and her own flag are never touched
        // (her flag never reaches here — guarded below; her hold is skipped
        // inside revertAutoPresidentFlag).
        if (currentUser.catKey !== 'president') {
          try {
            var rev = await DB.revertAutoPresidentFlag(remarkTarget.uuid, currentSemester, currentAY);
            if (rev && rev.reverted) {
              toast(flaggedName + ' is On Hold \u2014 College President approval reverted until all 9 offices clear again.', 'info');
            }
          } catch (revErr) {
            console.error(revErr);
            toast('Note: could not revert the College President approval (' + revErr.message + ').', 'info');
          }
        }

        closeRemarkModal();
        toast('Flagged: ' + flaggedName + ' is now On Hold.', 'info');
        await refreshSignatoryData();
      } catch (err) {
        console.error(err);
        toast('Flag failed: ' + err.message, 'error');
      } finally {
        setLoading(saveBtn, false);
      }
    });

    $('#remark-textarea').addEventListener('input', function () {
      $('#remark-error').classList.add('hidden');
    });

    // Semester switchers
    $('#sv-semester-select').addEventListener('change', function () {
      var parts = this.value.split('|');
      setSemesterSelection(parts[0], parts[1]);
      refreshStudentData();
    });

    $('#sa-semester-select').addEventListener('change', function () {
      var parts = this.value.split('|');
      setSemesterSelection(parts[0], parts[1]);
      refreshSignatoryData();
    });

    // Admin student management modal
    $('#sa-manage-students').addEventListener('click', openAdminModal);
    $('#admin-close').addEventListener('click', closeAdminModal);
    $('#admin-backdrop').addEventListener('click', closeAdminModal);
    $('#admin-back-btn').addEventListener('click', closeAdminEdit);
    $('#admin-edit-cancel').addEventListener('click', closeAdminEdit);

    var adminSearchTimer = null;
    $('#admin-search').addEventListener('input', function () {
      clearTimeout(adminSearchTimer);
      adminSearchTimer = setTimeout(renderAdminList, 150);
    });

    $('#admin-student-list').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-admin-edit]');
      if (btn) openAdminEdit(btn.dataset.adminEdit);
    });

    $('#admin-edit-form').addEventListener('submit', function (e) {
      e.preventDefault();
      saveAdminEdit();
    });

    // SAS Director: reset a student's password change limit
    $('#admin-reset-pw-count').addEventListener('click', resetAdminPasswordCount);

    // Register new student
    $('#admin-add-student-btn').addEventListener('click', openAdminRegister);
    $('#admin-register-back-btn').addEventListener('click', closeAdminRegister);
    $('#admin-register-cancel').addEventListener('click', closeAdminRegister);
    $('#admin-register-form').addEventListener('submit', function (e) {
      e.preventDefault();
      submitAdminRegister();
    });

    // Semester Clearance Management (SAS Director only)
    $('#sa-semester-mgmt').addEventListener('click', openSemesterMgmtModal);
    $('#semester-mgmt-close').addEventListener('click', closeSemesterMgmtModal);
    $('#semester-mgmt-backdrop').addEventListener('click', closeSemesterMgmtModal);

    // One-click initialize for a term that has no clearance records yet
    $('#sa-init-term-btn').addEventListener('click', initializeSelectedTerm);

    $('#sm-init-btn').addEventListener('click', submitCreateSemester);

    $('#sm-semester-list').addEventListener('click', async function (e) {
      var btn = e.target.closest('button[data-sm-activate], button[data-sm-edit]');
      if (!btn || !isSASDirector()) return;
      if (btn.hasAttribute('data-sm-activate')) {
        await setActiveSemester(btn.getAttribute('data-sm-activate'));
      } else {
        openSemesterEdit(btn.getAttribute('data-sm-edit'));
      }
    });

    $('#sm-edit-cancel').addEventListener('click', closeSemesterEdit);
    $('#sm-edit-back-btn').addEventListener('click', closeSemesterEdit);
    $('#sm-edit-save').addEventListener('click', saveSemesterEdit);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!$('#remark-modal').classList.contains('hidden')) closeRemarkModal();
        else if (!$('#semester-mgmt-modal').classList.contains('hidden')) {
          if (!$('#sm-edit-panel').classList.contains('hidden')) closeSemesterEdit();
          else closeSemesterMgmtModal();
        }
        else if (!$('#admin-modal').classList.contains('hidden')) {
          if (!$('#admin-register-panel').classList.contains('hidden')) closeAdminRegister();
          else if (!$('#admin-edit-panel').classList.contains('hidden')) closeAdminEdit();
          else closeAdminModal();
        }
      }
    });

    restoreRemember();
    showView('login');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
