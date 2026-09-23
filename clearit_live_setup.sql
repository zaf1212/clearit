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

-- Batch-initialize clearances for ALL ACTIVE students (Regular/Irregular only).
-- Existing records for the same (student, semester, A.Y., office) are skipped.
CREATE OR REPLACE FUNCTION fn_init_clearance(
  p_semester      TEXT,
  p_academic_year TEXT
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
  END AS overall_status
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
  sg.full_name AS signed_by_name
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