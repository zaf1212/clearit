-- =============================================================================
-- CLEARIT — Semester-based clearance migration
-- Run this in the Supabase SQL Editor ON YOUR EXISTING DATABASE.
-- Non-destructive: keeps all students, signatories, and existing clearance data.
-- =============================================================================

-- 1. Add semester / academic_year to clearance_records
ALTER TABLE clearance_records ADD COLUMN IF NOT EXISTS semester      TEXT;
ALTER TABLE clearance_records ADD COLUMN IF NOT EXISTS academic_year TEXT;

-- 2. Backfill existing records from their student's current enrollment
UPDATE clearance_records cr
SET semester = s.semester, academic_year = s.academic_year
FROM students s
WHERE s.id = cr.student_id
  AND (cr.semester IS NULL OR cr.academic_year IS NULL);

-- 3. Enforce NOT NULL going forward
ALTER TABLE clearance_records ALTER COLUMN semester      SET NOT NULL;
ALTER TABLE clearance_records ALTER COLUMN academic_year SET NOT NULL;

-- 4. Replace the old (student_id, category_id) uniqueness with the
--    semester-aware composite uniqueness
ALTER TABLE clearance_records DROP CONSTRAINT IF EXISTS uq_clearance_student_category;
ALTER TABLE clearance_records DROP CONSTRAINT IF EXISTS uq_clearance_student_semester;
ALTER TABLE clearance_records ADD CONSTRAINT uq_clearance_student_semester
  UNIQUE (student_id, semester, academic_year, category_id);

CREATE INDEX IF NOT EXISTS idx_clearance_semester
  ON clearance_records (student_id, semester, academic_year);

-- 5. Recreate the helper RPCs with semester-aware signatures
DROP FUNCTION IF EXISTS fn_approve_clearance CASCADE;
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

DROP FUNCTION IF EXISTS fn_flag_clearance CASCADE;
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

DROP FUNCTION IF EXISTS fn_init_clearance CASCADE;
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
  ON CONFLICT (student_id, semester, academic_year, category_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 6. Recreate the views with semester-aware scoping
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