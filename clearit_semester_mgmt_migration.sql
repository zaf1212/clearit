-- =============================================================================
-- CLEARIT — Semester Clearance Management migration (SAS Director)
-- Run this in the Supabase SQL Editor ON YOUR EXISTING DATABASE, AFTER
-- clearit_semester_migration.sql. Non-destructive: keeps all existing data.
--
-- What this adds:
--   1. A `role` column on signatories; the SAS Director is flagged 'sas_director'.
--   2. A `semesters` table tracking each academic semester + the single active one.
--   3. RPCs so the SAS Director can create, edit, and activate semesters
--      (each RPC verifies the caller's signatory email has role = 'sas_director').
--   4. fn_init_clearance now initializes ONLY active students
--      (enrollment_status IN ('Regular','Irregular')).
-- =============================================================================

-- 1. Signatory role (SAS Director only)
ALTER TABLE signatories ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'signatory';
UPDATE signatories SET role = 'sas_director' WHERE email = 'jennilyn.geagonia@tcc.edu.ph';

-- 2. Semesters table (one row per academic semester, at most one active)
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

-- 3. RPC: create (or fetch) a semester — SAS Director only
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

-- 4. RPC: set the "Current Active Semester" system flag — SAS Director only
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
  -- Two-step update with WHERE clauses so Supabase's safe-update protection
  -- (which rejects UPDATE/DELETE without a WHERE) never blocks this RPC.
  UPDATE semesters SET is_active = false WHERE is_active = true;
  UPDATE semesters SET is_active = true WHERE id = p_semester_id;
END;
$$;

-- 5. RPC: edit a semester's details — SAS Director only
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

-- 6. Batch initialization now targets ONLY active students.
--    Records already present for (student, semester, A.Y., office) are skipped.
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
  WHERE s.enrollment_status IN ('Regular','Irregular')
  ON CONFLICT (student_id, semester, academic_year, category_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- 7. Seed / flag the current active semester so login defaults are preserved
INSERT INTO semesters (semester, academic_year, is_active)
VALUES ('2nd Semester', '2025-2026', true)
ON CONFLICT (semester, academic_year) DO NOTHING;

-- 8. Row-Level Security (consistent with the rest of the schema)
ALTER TABLE semesters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all semesters" ON semesters;
CREATE POLICY "allow_all semesters" ON semesters FOR ALL USING (true) WITH CHECK (true);