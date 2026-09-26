-- =============================================================================
-- CLEARIT — ONE-FILE SETUP for your existing database
-- -----------------------------------------------------------------------------
-- Paste this WHOLE file into the Supabase SQL Editor and press Run.
-- It is fully REPEATABLE: running it again never fails ("already exists",
-- "does not exist", "requires a WHERE clause" are all handled).
-- Non-destructive: keeps all students, signatories, and clearance data.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. clearance_records: ensure the table exists, then add semester columns
-- -----------------------------------------------------------------------------
-- Self-healing: if clearance_records was ever dropped (with its views), this
-- recreates it exactly as the app expects.
CREATE TABLE IF NOT EXISTS clearance_records (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id    UUID        NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  category_id   UUID        NOT NULL REFERENCES signatory_categories(id) ON DELETE CASCADE,
  semester      TEXT        NOT NULL DEFAULT '1st Semester',
  academic_year TEXT        NOT NULL DEFAULT '2025-2026',
  status        TEXT        NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','cleared','hold')),
  remarks       TEXT,
  signed_at     TIMESTAMPTZ,
  signed_by     UUID        REFERENCES signatories(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_clearance_student_semester UNIQUE (student_id, semester, academic_year, category_id)
);

ALTER TABLE clearance_records ADD COLUMN IF NOT EXISTS semester      TEXT;
ALTER TABLE clearance_records ADD COLUMN IF NOT EXISTS academic_year TEXT;

-- Backfill existing records from their student's current enrollment
UPDATE clearance_records cr
SET semester = s.semester, academic_year = s.academic_year
FROM students s
WHERE s.id = cr.student_id
  AND (cr.semester IS NULL OR cr.academic_year IS NULL);

ALTER TABLE clearance_records ALTER COLUMN semester      SET NOT NULL;
ALTER TABLE clearance_records ALTER COLUMN academic_year SET NOT NULL;

-- Replace old uniqueness with the semester-aware composite key
ALTER TABLE clearance_records DROP CONSTRAINT IF EXISTS uq_clearance_student_category;
ALTER TABLE clearance_records DROP CONSTRAINT IF EXISTS uq_clearance_student_semester;
ALTER TABLE clearance_records ADD CONSTRAINT uq_clearance_student_semester
  UNIQUE (student_id, semester, academic_year, category_id);

CREATE INDEX IF NOT EXISTS idx_clearance_semester
  ON clearance_records (student_id, semester, academic_year);

-- -----------------------------------------------------------------------------
-- 2. signatories: add role (SAS Director flag)
-- -----------------------------------------------------------------------------
ALTER TABLE signatories ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'signatory';
UPDATE signatories SET role = 'sas_director' WHERE email = 'jennilyn.geagonia@tcc.edu.ph';

-- -----------------------------------------------------------------------------
-- 2b. students: password change tracking (max 3 self-service resets)
--     SAS Director can reset this back to 0 via Manage Students.
-- -----------------------------------------------------------------------------
ALTER TABLE students ADD COLUMN IF NOT EXISTS password_change_count INT NOT NULL DEFAULT 0;

-- -----------------------------------------------------------------------------
-- 2c. students: Year Level + Section/Block management (SAS Director)
--     Adds the two new columns, backfills them from the legacy combined
--     year_block ("3rd Year / Charity" → year_level='3rd Year',
--     section_block='Charity'), and indexes the new filter columns.
-- -----------------------------------------------------------------------------
ALTER TABLE students ADD COLUMN IF NOT EXISTS year_level    TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS section_block TEXT;

UPDATE students
SET year_level = NULLIF(btrim(split_part(year_block, '/', 1)), '')
WHERE year_level IS NULL AND year_block IS NOT NULL;

UPDATE students
SET section_block = NULLIF(btrim(split_part(year_block, '/', 2)), '')
WHERE section_block IS NULL AND year_block IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_students_year_level    ON students (year_level);
CREATE INDEX IF NOT EXISTS idx_students_section_block ON students (section_block);

-- -----------------------------------------------------------------------------
-- 3. semesters table (one row per academic semester; at most one active)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS semesters (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  semester      TEXT         NOT NULL,
  academic_year TEXT         NOT NULL,
  is_active     BOOLEAN      NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_semester_combo UNIQUE (semester, academic_year),
  CONSTRAINT chk_semester_name CHECK (semester IN ('1st Semester','2nd Semester','Summer / Midyear'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_semesters_single_active ON semesters ((true)) WHERE is_active;

-- -----------------------------------------------------------------------------
-- 4. Helper RPCs (all re-runnable with CREATE OR REPLACE)
-- -----------------------------------------------------------------------------

-- Approve a clearance for a specific (student, semester, A.Y., office)
CREATE OR REPLACE FUNCTION fn_approve_clearance(
  p_student_id    UUID,
  p_category_id   UUID,
  p_signatory_id  UUID,
  p_semester      TEXT,
  p_academic_year TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO clearance_records (student_id, category_id, status, remarks, signed_at, signed_by, semester, academic_year)
  VALUES (p_student_id, p_category_id, 'cleared', NULL, now(), p_signatory_id, p_semester, p_academic_year)
  ON CONFLICT (student_id, semester, academic_year, category_id) DO UPDATE
  SET status='cleared', remarks=NULL, signed_at=now(), signed_by=p_signatory_id;
END;
$$;

-- Flag a clearance On Hold for a specific (student, semester, A.Y., office)
CREATE OR REPLACE FUNCTION fn_flag_clearance(
  p_student_id    UUID,
  p_category_id   UUID,
  p_signatory_id  UUID,
  p_remarks       TEXT,
  p_semester      TEXT,
  p_academic_year TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO clearance_records (student_id, category_id, status, remarks, signed_at, signed_by, semester, academic_year)
  VALUES (p_student_id, p_category_id, 'hold', p_remarks, NULL, p_signatory_id, p_semester, p_academic_year)
  ON CONFLICT (student_id, semester, academic_year, category_id) DO UPDATE
  SET status='hold', remarks=p_remarks, signed_at=NULL, signed_by=p_signatory_id;
END;
$$;

-- Batch-initialize clearances for ACTIVE students (Regular/Irregular only).
-- Existing records for the same (student, semester, A.Y., office) are skipped.
-- Optional p_year_level / p_section_block narrow the batch to a Year Level
-- and/or Section (used by the SAS Director's semester initialization filters).
CREATE OR REPLACE FUNCTION fn_init_clearance(
  p_semester       TEXT,
  p_academic_year  TEXT,
  p_year_level     TEXT DEFAULT NULL,
  p_section_block  TEXT DEFAULT NULL
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO clearance_records (student_id, category_id, status, semester, academic_year)
  SELECT s.id, c.id, 'pending', p_semester, p_academic_year
  FROM students s
  CROSS JOIN signatory_categories c
  WHERE s.enrollment_status IN ('Regular','Irregular')
    AND (p_year_level    IS NULL OR s.year_level    = p_year_level)
    AND (p_section_block IS NULL OR s.section_block = p_section_block)
  ON CONFLICT (student_id, semester, academic_year, category_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Create (or fetch) a semester entry — SAS Director ONLY
CREATE OR REPLACE FUNCTION fn_upsert_semester(
  p_semester      TEXT,
  p_academic_year TEXT,
  p_sas_email     TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM signatories WHERE email = p_sas_email AND role = 'sas_director') THEN
    RAISE EXCEPTION 'Forbidden: only the SAS Director can create semesters.';
  END IF;
  IF p_semester NOT IN ('1st Semester','2nd Semester','Summer / Midyear') THEN
    RAISE EXCEPTION 'Invalid semester name. Use 1st Semester, 2nd Semester, or Summer / Midyear.';
  END IF;
  IF NOT p_academic_year ~ '^[0-9]{4}-[0-9]{4}$' THEN
    RAISE EXCEPTION 'Academic year must be in YYYY-YYYY format, e.g. 2026-2027.';
  END IF;

  SELECT id INTO v_id FROM semesters WHERE semester = p_semester AND academic_year = p_academic_year;
  IF v_id IS NULL THEN
    INSERT INTO semesters (semester, academic_year) VALUES (p_semester, p_academic_year)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;

-- Set the "Current Active Semester" flag — SAS Director ONLY
-- Uses WHERE clauses so Supabase's safe-update protection never blocks it.
CREATE OR REPLACE FUNCTION fn_activate_semester(
  p_semester_id UUID,
  p_sas_email   TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM signatories WHERE email = p_sas_email AND role = 'sas_director') THEN
    RAISE EXCEPTION 'Forbidden: only the SAS Director can manage semesters.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM semesters WHERE id = p_semester_id) THEN
    RAISE EXCEPTION 'Semester not found.';
  END IF;
  UPDATE semesters SET is_active = false WHERE is_active = true;
  UPDATE semesters SET is_active = true  WHERE id = p_semester_id;
END;
$$;

-- Edit a semester's details — SAS Director ONLY
CREATE OR REPLACE FUNCTION fn_update_semester(
  p_semester_id    UUID,
  p_semester       TEXT,
  p_academic_year  TEXT,
  p_sas_email      TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM signatories WHERE email = p_sas_email AND role = 'sas_director') THEN
    RAISE EXCEPTION 'Forbidden: only the SAS Director can edit semesters.';
  END IF;
  IF p_semester NOT IN ('1st Semester','2nd Semester','Summer / Midyear') THEN
    RAISE EXCEPTION 'Invalid semester name. Use 1st Semester, 2nd Semester, or Summer / Midyear.';
  END IF;
  IF NOT p_academic_year ~ '^[0-9]{4}-[0-9]{4}$' THEN
    RAISE EXCEPTION 'Academic year must be in YYYY-YYYY format, e.g. 2026-2027.';
  END IF;

  UPDATE semesters SET semester = p_semester, academic_year = p_academic_year WHERE id = p_semester_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Semester not found.'; END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Views (semester-aware)
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_clearance_details CASCADE;
DROP VIEW IF EXISTS v_dashboard_stats   CASCADE;
DROP VIEW IF EXISTS v_student_progress  CASCADE;

CREATE OR REPLACE VIEW v_student_progress AS
SELECT
  s.id AS student_id, s.institutional_id, s.full_name, s.year_block, s.program,
  s.semester, s.academic_year, s.enrollment_status, s.paid, s.paid_date,
  (SELECT COUNT(*) FROM signatory_categories) AS total_requirements,
  COALESCE(cc.cleared_count, 0) AS cleared_count,
  CASE
    WHEN COALESCE(cc.cleared_count,0) = (SELECT COUNT(*) FROM signatory_categories) THEN 100
    ELSE ROUND(COALESCE(cc.cleared_count,0) * 100.0 / (SELECT COUNT(*) FROM signatory_categories))
  END AS progress_pct,
  CASE
    WHEN EXISTS (SELECT 1 FROM clearance_records cr2
                 WHERE cr2.student_id=s.id AND cr2.status='hold'
                   AND cr2.semester=s.semester AND cr2.academic_year=s.academic_year) THEN 'on_hold'
    WHEN EXISTS (SELECT 1 FROM clearance_records cr3
                 WHERE cr3.student_id=s.id AND cr3.status='pending'
                   AND cr3.semester=s.semester AND cr3.academic_year=s.academic_year) THEN 'pending'
    WHEN COALESCE(cc.cleared_count,0) = (SELECT COUNT(*) FROM signatory_categories) THEN 'cleared'
    ELSE 'pending'
  END AS overall_status,
  s.year_level, s.section_block
FROM students s
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INT AS cleared_count FROM clearance_records cr
  WHERE cr.student_id=s.id AND cr.status='cleared'
    AND cr.semester=s.semester AND cr.academic_year=s.academic_year
) cc ON true;

CREATE OR REPLACE VIEW v_clearance_details AS
SELECT
  cr.id AS record_id, cr.student_id, s.institutional_id,
  s.full_name AS student_name, s.year_block, s.program,
  s.semester, s.academic_year, s.enrollment_status, s.paid, s.paid_date,
  cr.semester AS record_semester, cr.academic_year AS record_academic_year,
  sc.key AS category_key, sc.name AS category_name,
  sc.signatory_name, sc.display_order,
  cr.status, cr.remarks, cr.signed_at, cr.signed_by,
  sg.full_name AS signed_by_name,
  s.year_level, s.section_block
FROM clearance_records cr
JOIN students s              ON s.id  = cr.student_id
JOIN signatory_categories sc ON sc.id = cr.category_id
LEFT JOIN signatories sg     ON sg.id = cr.signed_by;

CREATE OR REPLACE VIEW v_dashboard_stats AS
SELECT
  (SELECT COUNT(*) FROM students) AS total_students,
  (SELECT COUNT(*) FROM v_student_progress WHERE overall_status='cleared') AS fully_cleared,
  (SELECT COUNT(*) FROM v_student_progress WHERE overall_status='pending') AS pending,
  (SELECT COUNT(*) FROM v_student_progress WHERE overall_status='on_hold')  AS on_hold;

-- -----------------------------------------------------------------------------
-- 6. Seed the current active semester (keeps the login default)
-- -----------------------------------------------------------------------------
INSERT INTO semesters (semester, academic_year, is_active)
VALUES ('2nd Semester', '2025-2026', true)
ON CONFLICT (semester, academic_year) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 7. Row-Level Security (policies are dropped first so re-runs never fail)
-- -----------------------------------------------------------------------------
ALTER TABLE signatory_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE students              ENABLE ROW LEVEL SECURITY;
ALTER TABLE signatories           ENABLE ROW LEVEL SECURITY;
ALTER TABLE semesters             ENABLE ROW LEVEL SECURITY;
ALTER TABLE clearance_records     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allow_all signatory_categories" ON signatory_categories;
CREATE POLICY "allow_all signatory_categories" ON signatory_categories FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "allow_all students" ON students;
CREATE POLICY "allow_all students" ON students FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "allow_all signatories" ON signatories;
CREATE POLICY "allow_all signatories" ON signatories FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "allow_all semesters" ON semesters;
CREATE POLICY "allow_all semesters" ON semesters FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "allow_all clearance_records" ON clearance_records;
CREATE POLICY "allow_all clearance_records" ON clearance_records FOR ALL USING (true) WITH CHECK (true);

-- -----------------------------------------------------------------------------
-- 8. Realtime: let student dashboards update live (no page refresh) when a
--     signatory signs off. Idempotent: repeated runs are ignored.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE clearance_records;
EXCEPTION
  WHEN duplicate_object THEN NULL; -- already a member of the publication
END $$;
-- =============================================================================
-- STUDENT ACADEMIC STATUS & TERM-TRANSITION LAYER
-- =============================================================================
-- GENERATED BLOCK - do not edit here. It is copied verbatim from
-- clearit_academic_status_migration.sql by sync-sql.ps1, so a fresh install and
-- a migrated database end up with identical schema, functions and views.
-- Re-run sync-sql.ps1 after editing the migration.
--
-- Adds: students.academic_status (Active/Dropped/Suspended/Graduated/Inactive),
-- the status-aware fn_init_clearance, the SAS setup-wizard RPC fn_init_new_term,
-- the CSV roster RPC fn_apply_roster_upload, the quick status toggle RPC
-- fn_set_student_academic_status, and a trigger that keeps clearance history
-- read-only for every term except the active one. All of it is idempotent.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) academic_status column
-- -----------------------------------------------------------------------------
ALTER TABLE students ADD COLUMN IF NOT EXISTS academic_status TEXT;
-- Every existing student is Active until the SAS Director says otherwise.
UPDATE students
SET academic_status = 'Active'
WHERE academic_status IS NULL OR btrim(academic_status) = '';
ALTER TABLE students ALTER COLUMN academic_status SET DEFAULT 'Active';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM students WHERE academic_status IS NULL) THEN
    RAISE EXCEPTION 'Could not normalize students.academic_status — aborting.';
  END IF;
END;
$$;
ALTER TABLE students ALTER COLUMN academic_status SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_students_academic_status'
  ) THEN
    ALTER TABLE students ADD CONSTRAINT chk_students_academic_status
      CHECK (academic_status IN ('Active','Dropped','Suspended','Graduated','Inactive'));
  END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS idx_students_academic_status ON students (academic_status);
-- -----------------------------------------------------------------------------
-- 2) Year Level + Section/Block (idempotent — safe if the earlier migration ran)
-- -----------------------------------------------------------------------------
ALTER TABLE students ADD COLUMN IF NOT EXISTS year_level    TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS section_block TEXT;
UPDATE students
SET year_level = NULLIF(btrim(split_part(year_block, '/', 1)), '')
WHERE year_level IS NULL AND year_block IS NOT NULL;
UPDATE students
SET section_block = NULLIF(btrim(split_part(year_block, '/', 2)), '')
WHERE section_block IS NULL AND year_block IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_students_year_level    ON students (year_level);
CREATE INDEX IF NOT EXISTS idx_students_section_block ON students (section_block);
-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------
-- SAS Director gate. Every term-transition / roster RPC calls this first.
CREATE OR REPLACE FUNCTION fn_assert_sas (p_sas_email TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF p_sas_email IS NULL OR btrim(p_sas_email) = '' THEN
    RAISE EXCEPTION 'Forbidden: the SAS Director email is required.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM signatories WHERE lower(email) = lower(btrim(p_sas_email))
      AND role = 'sas_director'
  ) THEN
    RAISE EXCEPTION 'Forbidden: only the SAS Director can perform this action.';
  END IF;
END;
$$;
-- Term label validator shared by the semester RPCs.
CREATE OR REPLACE FUNCTION fn_assert_term (p_semester TEXT, p_academic_year TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF p_semester NOT IN ('1st Semester','2nd Semester','Summer / Midyear') THEN
    RAISE EXCEPTION 'Invalid semester name. Use 1st Semester, 2nd Semester, or Summer / Midyear.';
  END IF;
  IF p_academic_year IS NULL OR p_academic_year !~ '^[0-9]{4}-[0-9]{4}$' THEN
    RAISE EXCEPTION 'Academic year must be in YYYY-YYYY format, e.g. 2026-2027.';
  END IF;
END;
$$;
-- "Is this student allowed to receive NEW clearance records this term?"
-- A student qualifies only while Active. enrollment_status (Regular/Irregular)
-- stays an orthogonal academic-standing flag and must also pass.
CREATE OR REPLACE FUNCTION fn_is_clearance_eligible (p_academic_status TEXT, p_enrollment_status TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE(NULLIF(btrim(p_academic_status), ''), 'Active') = 'Active'
     AND p_enrollment_status IN ('Regular', 'Irregular');
$$;
-- -----------------------------------------------------------------------------
-- 3) fn_init_clearance — now status-aware, optional custom roster
--
--    Dropped / Suspended / Graduated / Inactive students are skipped, so they
--    can never be initialized into a new term. Existing rows for the target
--    term are left alone (ON CONFLICT DO NOTHING) and no prior term is touched.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS fn_init_clearance(TEXT, TEXT)             CASCADE;
DROP FUNCTION IF EXISTS fn_init_clearance(TEXT, TEXT, TEXT, TEXT) CASCADE;
CREATE OR REPLACE FUNCTION fn_init_clearance(
  p_semester      TEXT,
  p_academic_year TEXT,
  p_year_level    TEXT   DEFAULT NULL,
  p_section_block TEXT   DEFAULT NULL,
  p_student_ids   UUID[] DEFAULT NULL,
  p_sas_email     TEXT   DEFAULT NULL
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  PERFORM fn_assert_term(p_semester, p_academic_year);
  -- Auth is enforced whenever a caller identifies itself; the check is skipped
  -- only for legacy/internal calls that pass NULL.
  IF p_sas_email IS NOT NULL THEN
    PERFORM fn_assert_sas(p_sas_email);
  END IF;
  INSERT INTO clearance_records (student_id, category_id, status, semester, academic_year)
  SELECT s.id, c.id, 'pending', p_semester, p_academic_year
  FROM students s
  CROSS JOIN signatory_categories c
  WHERE fn_is_clearance_eligible(s.academic_status, s.enrollment_status)
    AND (p_year_level    IS NULL OR s.year_level    = p_year_level)
    AND (p_section_block IS NULL OR s.section_block = p_section_block)
    AND (p_student_ids   IS NULL OR s.id = ANY (p_student_ids))
  ON CONFLICT (student_id, semester, academic_year, category_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
-- -----------------------------------------------------------------------------
-- 4) fn_init_new_term — the SAS Director "Initialize New Semester" wizard
--
--    p_mode = 'roll_forward' : carry every Active student into the new term,
--                               stamping their semester tags and optionally
--                               promoting their year level.
--    p_mode = 'custom'       : only the students in p_student_ids (or matched
--                               by the Year/Section filters) are stamped and
--                               initialized. Everyone else is untouched.
--
--    Returns a JSONB breakdown so the UI can report exactly what happened.
--    Never updates or deletes an existing clearance_record.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_init_new_term(
  p_semester      TEXT,
  p_academic_year TEXT,
  p_mode          TEXT,
  -- p_sas_email must be declared BEFORE the first parameter that has a DEFAULT:
  -- Postgres rejects a signature where a non-defaulted parameter follows a
  -- defaulted one (42P13). It is deliberately kept mandatory so the call fails at
  -- the signature rather than relying on fn_assert_sas to catch a NULL. The app
  -- calls this by parameter name over PostgREST, so the order is not significant.
  p_sas_email     TEXT,
  p_student_ids   UUID[] DEFAULT NULL,
  p_promote       BOOLEAN DEFAULT false,
  p_year_level    TEXT    DEFAULT NULL,
  p_section_block TEXT    DEFAULT NULL,
  p_activate      BOOLEAN DEFAULT true
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_semester_id   UUID;
  v_stamped       INTEGER := 0;
  v_promoted      INTEGER := 0;
  v_created       INTEGER := 0;
  v_active        INTEGER := 0;
  v_dropped       INTEGER := 0;
  v_suspended     INTEGER := 0;
  v_graduated     INTEGER := 0;
  v_inactive      INTEGER := 0;
  v_cohort        UUID[];
BEGIN
  PERFORM fn_assert_sas(p_sas_email);
  PERFORM fn_assert_term(p_semester, p_academic_year);
  IF p_mode IS NULL OR p_mode NOT IN ('roll_forward', 'custom') THEN
    RAISE EXCEPTION 'Invalid roster mode. Use roll_forward or custom.';
  END IF;
  ------------------------------------------------------------------
  -- Roster-wide status census (drives the "skipped" numbers in the UI)
  ------------------------------------------------------------------
  -- One INTO clause, after the whole select list. Repeating INTO per column
  -- is not valid PL/pgSQL: the parser reads the second count() as being in
  -- expression position and tries to resolve it as a variable ("count is not
  -- a known variable").
  SELECT
    count(*) FILTER (WHERE academic_status = 'Active'),
    count(*) FILTER (WHERE academic_status = 'Dropped'),
    count(*) FILTER (WHERE academic_status = 'Suspended'),
    count(*) FILTER (WHERE academic_status = 'Graduated'),
    count(*) FILTER (WHERE academic_status = 'Inactive')
  INTO v_active, v_dropped, v_suspended, v_graduated, v_inactive
  FROM students;
  ------------------------------------------------------------------
  -- Resolve the cohort this run applies to
  ------------------------------------------------------------------
  IF p_mode = 'custom' THEN
    IF p_student_ids IS NOT NULL THEN
      v_cohort := p_student_ids;
    ELSE
      SELECT COALESCE(array_agg(s.id), ARRAY[]::UUID[]) INTO v_cohort
      FROM students s
      WHERE (p_year_level    IS NULL OR s.year_level    = p_year_level)
        AND (p_section_block IS NULL OR s.section_block = p_section_block);
    END IF;
    IF cardinality(v_cohort) = 0 THEN
      RAISE EXCEPTION 'No students matched the custom roster selection.';
    END IF;
  ELSE
    SELECT COALESCE(array_agg(s.id), ARRAY[]::UUID[]) INTO v_cohort
    FROM students s
    WHERE fn_is_clearance_eligible(s.academic_status, s.enrollment_status);
  END IF;
  ------------------------------------------------------------------
  -- Register the semester (never downgrades an already-active term)
  ------------------------------------------------------------------
  INSERT INTO semesters (semester, academic_year)
  VALUES (p_semester, p_academic_year)
  ON CONFLICT (semester, academic_year) DO NOTHING;
  SELECT id INTO v_semester_id
  FROM semesters
  WHERE semester = p_semester AND academic_year = p_academic_year;
  IF v_semester_id IS NULL THEN
    RAISE EXCEPTION 'Could not register the semester % / %.', p_semester, p_academic_year;
  END IF;
  IF p_activate THEN
    UPDATE semesters SET is_active = false WHERE is_active = true;
    UPDATE semesters SET is_active = true  WHERE id = v_semester_id;
  END IF;
  ------------------------------------------------------------------
  -- Stamp the cohort's term tags
  ------------------------------------------------------------------
  IF p_mode = 'roll_forward' THEN
    -- Year promotion: 1st -> 2nd -> 3rd -> 4th, 4th stays (they are graduating,
    -- the SAS Director flips them to 'Graduated'). Section names that embed the
    -- year digit ("BSIT 2-A") are bumped in step so the two stay consistent.
    IF p_promote THEN
      -- 1) bump the year level: 1st -> 2nd -> 3rd -> 4th.
      --    4th Year is left alone — retiring them is the SAS Director's call
      --    (flip them to 'Graduated' from Manage Students).
      UPDATE students
      SET year_level = CASE year_level
            WHEN '1st Year' THEN '2nd Year'
            WHEN '2nd Year' THEN '3rd Year'
            WHEN '3rd Year' THEN '4th Year'
            ELSE year_level
          END
      WHERE id = ANY (v_cohort)
        AND year_level IN ('1st Year', '2nd Year', '3rd Year');
      GET DIAGNOSTICS v_promoted = ROW_COUNT;
      -- 2) bump the year digit embedded in the section name
      --    ("BSIT 2-A" -> "BSIT 3-A"), capped at 4.
      --    Uses overlay() at the offset of the first digit rather than a
      --    regexp_replace backreference, so the result never depends on the
      --    server's standard_conforming_strings setting.
      UPDATE students
      SET section_block = overlay(
            section_block
            PLACING CASE substring(section_block FROM '^[^0-9]*([1-4])')
                        WHEN '1' THEN '2'
                        WHEN '2' THEN '3'
                        ELSE '4'
                      END
            FROM (length(substring(section_block FROM '^[^0-9]*')) + 1)
          )
      WHERE id = ANY (v_cohort)
        AND section_block ~ '^[^0-9]*[1-4]';
      -- 3) keep the legacy combined year_block in step.
      UPDATE students
      SET year_block = CASE
            WHEN year_level IS NOT NULL AND section_block IS NOT NULL
              THEN year_level || ' / ' || section_block
            WHEN year_level IS NOT NULL
              THEN year_level
            ELSE COALESCE(year_block, section_block)
          END
      WHERE id = ANY (v_cohort);
    END IF;
    UPDATE students
    SET semester = p_semester, academic_year = p_academic_year
    WHERE id = ANY (v_cohort);
    GET DIAGNOSTICS v_stamped = ROW_COUNT;
  ELSE
    -- Custom roster: stamp only the selected students, and only the ones that
    -- are still eligible, so a Dropped student listed by mistake stays put.
    UPDATE students
    SET semester = p_semester, academic_year = p_academic_year
    WHERE id = ANY (v_cohort)
      AND fn_is_clearance_eligible(academic_status, enrollment_status);
    GET DIAGNOSTICS v_stamped = ROW_COUNT;
  END IF;
  ------------------------------------------------------------------
  -- Generate this term's clearance records (append-only)
  ------------------------------------------------------------------
  SELECT count(*) INTO v_created
  FROM (
    INSERT INTO clearance_records (student_id, category_id, status, semester, academic_year)
    SELECT s.id, c.id, 'pending', p_semester, p_academic_year
    FROM students s
    CROSS JOIN signatory_categories c
    WHERE fn_is_clearance_eligible(s.academic_status, s.enrollment_status)
      AND s.id = ANY (v_cohort)
    ON CONFLICT (student_id, semester, academic_year, category_id) DO NOTHING
    RETURNING 1
  ) created;
  RETURN jsonb_build_object(
    'mode',                p_mode,
    'semester',            p_semester,
    'academic_year',       p_academic_year,
    'cohort_size',         cardinality(v_cohort),
    'students_stamped',    v_stamped,
    'students_promoted',   v_promoted,
    'records_created',     v_created,
    'skipped_dropped',     v_dropped,
    'skipped_suspended',   v_suspended,
    'skipped_graduated',   v_graduated,
    'skipped_inactive',    v_inactive,
    'roster_active',       v_active
  );
END;
$$;
-- -----------------------------------------------------------------------------
-- 5) fn_apply_roster_upload — apply a CSV roster row by row
--
--    p_rows: JSONB array of objects, each optionally carrying
--      { "institutional_id": "...", "full_name": "...",
--        "academic_status": "Active|Dropped|Suspended|Graduated|Inactive",
--        "year_level": "2nd Year", "section_block": "BSIT 2-A" }
--    Only institutional_id is required. Matching is case-insensitive.
--    Returns a JSONB report: matched / updated / unknown IDs.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_apply_roster_upload(
  p_rows     JSONB,
  p_sas_email TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_row        JSONB;
  v_student    students%ROWTYPE;
  v_iid        TEXT;
  v_status     TEXT;
  v_year       TEXT;
  v_section    TEXT;
  v_matched    INTEGER := 0;
  v_updated    INTEGER := 0;
  v_unknown    TEXT[] := ARRAY[]::TEXT[];
  v_norm_year  TEXT;
  v_norm_sec   TEXT;
BEGIN
  PERFORM fn_assert_sas(p_sas_email);
  IF p_rows IS NULL OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'The uploaded roster is empty.';
  END IF;
  FOR v_row IN SELECT jsonb_array_elements(p_rows)
  LOOP
    v_iid := NULLIF(btrim(v_row ->> 'institutional_id'), '');
    IF v_iid IS NULL THEN
      CONTINUE;  -- skip rows with no ID rather than aborting the whole upload
    END IF;
    SELECT * INTO v_student
    FROM students
    WHERE lower(institutional_id) = lower(v_iid);
    IF NOT FOUND THEN
      v_unknown := array_append(v_unknown, v_iid);
      CONTINUE;
    END IF;
    v_matched := v_matched + 1;
    -- academic_status
    v_status := NULLIF(btrim(v_row ->> 'academic_status'), '');
    IF v_status IS NOT NULL THEN
      IF v_status NOT IN ('Active','Dropped','Suspended','Graduated','Inactive') THEN
        RAISE EXCEPTION 'Invalid academic status "%" for student % — use Active, Dropped, Suspended, Graduated, or Inactive.', v_status, v_iid;
      END IF;
    END IF;
    v_year    := NULLIF(btrim(v_row ->> 'year_level'), '');
    v_section := NULLIF(btrim(v_row ->> 'section_block'), '');
    v_norm_year := COALESCE(v_year, v_student.year_level);
    v_norm_sec  := COALESCE(v_section, v_student.section_block);
    UPDATE students
    SET academic_status = COALESCE(v_status, academic_status),
        year_level      = v_norm_year,
        section_block   = v_norm_sec,
        year_block      = CASE
                             WHEN v_norm_year IS NOT NULL AND v_norm_sec IS NOT NULL
                               THEN v_norm_year || ' / ' || v_norm_sec
                             WHEN v_norm_year IS NOT NULL AND v_student.section_block IS NOT NULL
                               THEN v_norm_year || ' / ' || v_student.section_block
                             ELSE COALESCE(year_block, v_norm_year, v_norm_sec)
                           END
    WHERE id = v_student.id;
    v_updated := v_updated + 1;
  END LOOP;
  RETURN jsonb_build_object(
    'rows',     jsonb_array_length(p_rows),
    'matched',  v_matched,
    'updated',  v_updated,
    'unknown',  to_jsonb(v_unknown)
  );
END;
$$;
-- -----------------------------------------------------------------------------
-- 6) fn_set_student_academic_status — quick status toggles from Manage Students
--
--    Changing a status never rewrites history: existing clearance_records for
--    the current or any past term are left exactly as they are. A student
--    marked Dropped/Suspended/Graduated simply stops receiving NEW records.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_set_student_academic_status(
  p_student_ids     UUID[],
  p_academic_status TEXT,
  p_sas_email       TEXT
) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  PERFORM fn_assert_sas(p_sas_email);
  IF p_academic_status IS NULL
     OR p_academic_status NOT IN ('Active','Dropped','Suspended','Graduated','Inactive') THEN
    RAISE EXCEPTION 'Invalid academic status. Use Active, Dropped, Suspended, Graduated, or Inactive.';
  END IF;
  IF p_student_ids IS NULL OR cardinality(p_student_ids) = 0 THEN
    RAISE EXCEPTION 'No students selected.';
  END IF;
  UPDATE students
  SET academic_status = p_academic_status
  WHERE id = ANY (p_student_ids);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count = 0 THEN
    RAISE EXCEPTION 'No matching students were updated.';
  END IF;
  RETURN v_count;
END;
$$;
-- -----------------------------------------------------------------------------
-- 7) Clearance history is read-only for past terms
--
--    Approving / flagging during the ACTIVE term keeps working. Any UPDATE or
--    DELETE aimed at a term other than the active one is rejected outright, so
--    a mis-click (or a buggy script) can never rewrite a historical log.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_guard_clearance_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_active_sem TEXT;
  v_active_ay  TEXT;
  v_allowed    BOOLEAN := true;
BEGIN
  SELECT semester, academic_year INTO v_active_sem, v_active_ay
  FROM semesters
  WHERE is_active
  LIMIT 1;
  -- With no active term configured there is nothing to protect, so allow it.
  IF v_active_sem IS NOT NULL THEN
    v_allowed := (COALESCE(OLD.semester, '') = v_active_sem
              AND COALESCE(OLD.academic_year, '') = v_active_ay);
  END IF;
  IF NOT v_allowed THEN
    RAISE EXCEPTION
      'Clearance history is read-only: % / % cannot be modified. Only the active term (% / %) may be changed.',
      OLD.semester, OLD.academic_year, v_active_sem, v_active_ay
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- NEW is an unassigned record on DELETE, so branch on TG_OP instead of
  -- coalescing the two.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_clearance_history_guard ON clearance_records;
CREATE TRIGGER trg_clearance_history_guard
  BEFORE UPDATE OR DELETE ON clearance_records
  FOR EACH ROW EXECUTE FUNCTION fn_guard_clearance_history();
-- -----------------------------------------------------------------------------
-- 8) Rebuild the views with the new columns.
--    DROP + CREATE (rather than CREATE OR REPLACE) so the result is identical
--    no matter which earlier migrations have been run on this database.
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS v_student_progress CASCADE;
CREATE VIEW v_student_progress AS
SELECT
  s.id AS student_id, s.institutional_id, s.full_name, s.year_block, s.program,
  s.semester, s.academic_year, s.enrollment_status, s.paid, s.paid_date,
  (SELECT COUNT(*) FROM signatory_categories) AS total_requirements,
  COALESCE(cc.cleared_count, 0) AS cleared_count,
  CASE
    WHEN COALESCE(cc.cleared_count,0) = (SELECT COUNT(*) FROM signatory_categories) THEN 100
    ELSE ROUND(COALESCE(cc.cleared_count,0) * 100.0 / (SELECT COUNT(*) FROM signatory_categories))
  END AS progress_pct,
  CASE
    WHEN EXISTS (SELECT 1 FROM clearance_records cr2
                 WHERE cr2.student_id=s.id AND cr2.status='hold'
                   AND cr2.semester=s.semester AND cr2.academic_year=s.academic_year) THEN 'on_hold'
    WHEN EXISTS (SELECT 1 FROM clearance_records cr3
                 WHERE cr3.student_id=s.id AND cr3.status='pending'
                   AND cr3.semester=s.semester AND cr3.academic_year=s.academic_year) THEN 'pending'
    WHEN COALESCE(cc.cleared_count,0) = (SELECT COUNT(*) FROM signatory_categories) THEN 'cleared'
    ELSE 'pending'
  END AS overall_status,
  s.year_level, s.section_block, s.academic_status
FROM students s
LEFT JOIN LATERAL (
  SELECT COUNT(*)::INT AS cleared_count FROM clearance_records cr
  WHERE cr.student_id=s.id AND cr.status='cleared'
    AND cr.semester=s.semester AND cr.academic_year=s.academic_year
) cc ON true;
DROP VIEW IF EXISTS v_clearance_details CASCADE;
CREATE VIEW v_clearance_details AS
SELECT
  cr.id AS record_id, cr.student_id, s.institutional_id,
  s.full_name AS student_name, s.year_block, s.program,
  s.semester, s.academic_year, s.enrollment_status, s.paid, s.paid_date,
  cr.semester AS record_semester, cr.academic_year AS record_academic_year,
  sc.key AS category_key, sc.name AS category_name,
  sc.signatory_name, sc.display_order,
  cr.status, cr.remarks, cr.signed_at, cr.signed_by,
  sg.full_name AS signed_by_name,
  s.year_level, s.section_block, s.academic_status
FROM clearance_records cr
JOIN students s              ON s.id  = cr.student_id
JOIN signatory_categories sc ON sc.id = cr.category_id
LEFT JOIN signatories sg     ON sg.id = cr.signed_by;
-- -----------------------------------------------------------------------------
-- 9) Sign the SAS Director in as Active (matches the seeded signatories row)
-- -----------------------------------------------------------------------------
UPDATE students SET academic_status = 'Active' WHERE academic_status IS NULL;

-- ============================== END GENERATED BLOCK ===============================
