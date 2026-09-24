-- =============================================================================
-- CLEARIT — Year Level & Section/Block Management Migration
-- Target: LIVE database (Supabase Dashboard → SQL Editor → New query → Run)
--
-- What this does (idempotent, safe to re-run, deletes nothing):
--   1. Adds year_level + section_block columns to students
--   2. Backfills them from the legacy combined year_block ("3rd Year / Charity")
--   3. Adds filter indexes
--   4. Extends fn_init_clearance with optional Year / Section filters
--   5. Exposes the new columns through v_student_progress / v_clearance_details
--
-- Until this is run, the web app still works: the UI falls back to splitting
-- year_block client-side, and the SAS batch-assign button shows a clear hint
-- pointing to this file. After running it, the full feature is live with no
-- further code changes needed.
-- =============================================================================

BEGIN;

-- 1) Columns (nullable: backfilled next, and pre-migration the app works
--    without them by splitting year_block itself).
ALTER TABLE students ADD COLUMN IF NOT EXISTS year_level    TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS section_block TEXT;

-- 2) Backfill from the legacy combined value, e.g. "3rd Year / Charity"
UPDATE students
SET year_level = NULLIF(btrim(split_part(year_block, '/', 1)), '')
WHERE year_level IS NULL AND year_block IS NOT NULL;

UPDATE students
SET section_block = NULLIF(btrim(split_part(year_block, '/', 2)), '')
WHERE section_block IS NULL AND year_block IS NOT NULL;

-- 3) Indexes used by the new Year / Section filters
CREATE INDEX IF NOT EXISTS idx_students_year_level    ON students (year_level);
CREATE INDEX IF NOT EXISTS idx_students_section_block ON students (section_block);

-- 4) fn_init_clearance — optional Year Level + Section/Block filters.
--    The existing 2-argument call keeps working; the app passes
--    p_year_level / p_section_block only when a filter is chosen.
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

-- 5) Expose the new columns through the views the app reads (so the signatory
--    dashboard's Year / Section filters and the SAS batch list get them).
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

COMMIT;