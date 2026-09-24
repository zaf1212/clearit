-- =============================================================================
-- CLEARIT — Talisay City College IT Department
-- Full PostgreSQL Schema + Seed Data for Supabase SQL Editor
-- =============================================================================

-- 0. Extensions
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Clean slate (safe re-runs)
-- =============================================================================
DROP VIEW  IF EXISTS v_student_progress       CASCADE;
DROP VIEW  IF EXISTS v_clearance_details      CASCADE;
DROP VIEW  IF EXISTS v_dashboard_stats        CASCADE;
DROP FUNCTION IF EXISTS fn_approve_clearance   CASCADE;
DROP FUNCTION IF EXISTS fn_flag_clearance      CASCADE;
DROP FUNCTION IF EXISTS fn_reset_clearance     CASCADE;
DROP FUNCTION IF EXISTS fn_init_clearance      CASCADE;
DROP FUNCTION IF EXISTS fn_upsert_semester     CASCADE;
DROP FUNCTION IF EXISTS fn_activate_semester   CASCADE;
DROP FUNCTION IF EXISTS fn_update_semester     CASCADE;
DROP TABLE IF EXISTS clearance_records        CASCADE;
DROP TABLE IF EXISTS semesters                CASCADE;
DROP TABLE IF EXISTS signatories              CASCADE;
DROP TABLE IF EXISTS students                 CASCADE;
DROP TABLE IF EXISTS signatory_categories     CASCADE;

-- 2. Tables
-- =============================================================================

-- 2a. signatory_categories — the nine clearance signatory offices
CREATE TABLE signatory_categories (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key           TEXT        UNIQUE NOT NULL,
  name          TEXT        NOT NULL,
  signatory_name TEXT       NOT NULL,       -- the actual person holding the role
  display_order SMALLINT    NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2b. students
CREATE TABLE students (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  institutional_id  TEXT        UNIQUE NOT NULL,
  full_name         TEXT        NOT NULL,
  email             TEXT        UNIQUE NOT NULL,
  password_hash     TEXT        NOT NULL,
  year_block        TEXT        NOT NULL,
  year_level        TEXT,
  section_block     TEXT,
  program           TEXT        NOT NULL DEFAULT 'BSIT',
  semester          TEXT        NOT NULL DEFAULT '1st Semester',
  academic_year     TEXT        NOT NULL DEFAULT '2025-2026',
  enrollment_status TEXT        NOT NULL DEFAULT 'Regular',
  paid              BOOLEAN     NOT NULL DEFAULT false,
  paid_date         TIMESTAMPTZ,
  password_change_count INT    NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2c. signatories
CREATE TABLE signatories (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        UNIQUE NOT NULL,
  password_hash TEXT        NOT NULL,
  full_name     TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'signatory',
  category_id   UUID        NOT NULL REFERENCES signatory_categories(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2d. semesters — one row per academic semester; at most one is active.
--     The active semester is the default view for students and signatories.
CREATE TABLE semesters (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  semester      TEXT         NOT NULL,
  academic_year TEXT         NOT NULL,
  is_active     BOOLEAN      NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_semester_combo UNIQUE (semester, academic_year),
  CONSTRAINT chk_semester_name CHECK (semester IN ('1st Semester','2nd Semester','Summer / Midyear'))
);
CREATE UNIQUE INDEX uq_semesters_single_active ON semesters ((true)) WHERE is_active;

-- 2e. clearance_records — semester-based; each (student, semester, A.Y., office) is one row
CREATE TABLE clearance_records (
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
  -- One clearance row per student per semester per A.Y. per signatory office.
  -- Approvals from previous semesters are preserved, never overwritten.
  CONSTRAINT uq_clearance_student_semester UNIQUE (student_id, semester, academic_year, category_id)
);

-- 3. Indexes
-- =============================================================================
CREATE INDEX idx_students_inst_id        ON students (institutional_id);
CREATE INDEX idx_students_year_block     ON students (year_block);
CREATE INDEX idx_students_year_level     ON students (year_level);
CREATE INDEX idx_students_section_block  ON students (section_block);
CREATE INDEX idx_signatories_category    ON signatories (category_id);
CREATE INDEX idx_clearance_student       ON clearance_records (student_id);
CREATE INDEX idx_clearance_semester      ON clearance_records (student_id, semester, academic_year);
CREATE INDEX idx_clearance_category      ON clearance_records (category_id);
CREATE INDEX idx_clearance_status        ON clearance_records (status);

-- 4. Helper functions
-- =============================================================================

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

-- Starting a new clearance cycle: spawn one 'pending' record for EVERY ACTIVE
-- student (enrollment_status IN ('Regular','Irregular')) for every signatory
-- office, for the given semester/A.Y. Records that already exist for that
-- (student, semester, A.Y., office) are left untouched, so old history is
-- preserved. Returns the number of new records created.
-- Optional p_year_level / p_section_block narrow the batch (used by the SAS
-- Director's semester initialization filters).
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

-- Semester management (SAS Director only). Every RPC verifies that the calling
-- signatory email has role = 'sas_director' before mutating the semesters table.

-- Create (or fetch) a semester entry.
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

-- Set the "Current Active Semester" system flag.
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

-- Edit a semester's details.
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

-- 5. Views
-- =============================================================================

CREATE OR REPLACE VIEW v_student_progress AS
SELECT
  s.id AS student_id, s.institutional_id, s.full_name, s.year_block,
  s.year_level, s.section_block, s.program,
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
  s.full_name AS student_name, s.year_block, s.year_level, s.section_block, s.program,
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

-- 6. Seed data
-- =============================================================================

-- 6a. Signatory categories (9 TCC clearance offices)
INSERT INTO signatory_categories (id, key, name, signatory_name, display_order) VALUES
  ('a0000000-0000-0000-0000-000000000001','treasury',        'Treasury In-charge',                   'Mr. Arnel Zafra',                           1),
  ('a0000000-0000-0000-0000-000000000002','campusMinistry',  'Campus Ministry In-charge',            'Riza S. Archival / Mrs. Ma. Clara Archival',2),
  ('a0000000-0000-0000-0000-000000000003','discipline',       'Student Conduct & Discipline Officer', 'Mae R. Arellana, LPT',                     3),
  ('a0000000-0000-0000-0000-000000000004','librarian',        'College Librarian',                    'Ma. Lourdes F. Mediano',                   4),
  ('a0000000-0000-0000-0000-000000000005','propertyCustodian','College Property Custodian',           'Mr. Jade Geraldez',                        5),
  ('a0000000-0000-0000-0000-000000000006','studentOrg',       'Student Organization Coordinator',     'Ms. Fritzie D. Formis',                    6),
  ('a0000000-0000-0000-0000-000000000007','studentAffairs',   'Student Affairs Services Director',    'Mrs. Jennilyn D. Geagonia / Engr. Raymond Geagonia', 7),
  ('a0000000-0000-0000-0000-000000000008','registrar',        'College Registrar',                    'Mrs. Wendelyn Labajo',                     8),
  ('a0000000-0000-0000-0000-000000000009','dean',             'Program Dean',                         'Glen L Tabucanon',                         9),
  ('a0000000-0000-0000-0000-000000000010','president',        'College President (Final Approval)',    'Richel N. Bacaltos, Ed.D.',               10);

-- 6b. Students
INSERT INTO students (id, institutional_id, full_name, email, password_hash, year_block, year_level, section_block, program, semester, academic_year, enrollment_status, paid, paid_date) VALUES
  ('b0000000-0000-0000-0000-000000000001','2023-5548','Jerame Abing',    'jerame.abing@tcc.edu.ph',     crypt('password123',gen_salt('bf')),'3rd Year / Generosity','3rd Year','Generosity','BSINDTECH-COMPTECH','2nd Semester','2025-2026','Regular', true, '2026-05-19'),
  ('b0000000-0000-0000-0000-000000000002','2023-5549','Maria Santos',    'maria.santos@tcc.edu.ph',     crypt('password123',gen_salt('bf')),'3rd Year / Charity',  '3rd Year','Charity',  'BSIT',               '2nd Semester','2025-2026','Regular', true, '2026-05-20'),
  ('b0000000-0000-0000-0000-000000000003','2024-6601','Pedro Reyes',     'pedro.reyes@tcc.edu.ph',      crypt('password123',gen_salt('bf')),'2nd Year / Faith',    '2nd Year','Faith',    'BSIT',               '2nd Semester','2025-2026','Regular', true, '2026-05-21'),
  ('b0000000-0000-0000-0000-000000000004','2022-7710','Ana Garcia',      'ana.garcia@tcc.edu.ph',       crypt('password123',gen_salt('bf')),'4th Year / Hope',     '4th Year','Hope',     'BSIT',               '2nd Semester','2025-2026','Regular', true, '2026-05-18'),
  ('b0000000-0000-0000-0000-000000000005','2023-5550','Jose Ramirez',    'jose.ramirez@tcc.edu.ph',     crypt('password123',gen_salt('bf')),'3rd Year / Love',     '3rd Year','Love',     'BSIT',               '2nd Semester','2025-2026','Regular', false, NULL);

-- 6c. Signatories
INSERT INTO signatories (id, email, password_hash, full_name, role, category_id) VALUES
  ('c0000000-0000-0000-0000-000000000001','arnel.zafra@tcc.edu.ph',           crypt('admin123',gen_salt('bf')),'Mr. Arnel Zafra',                           'signatory',   'a0000000-0000-0000-0000-000000000001'),
  ('c0000000-0000-0000-0000-000000000002','riza.archival@tcc.edu.ph',        crypt('admin123',gen_salt('bf')),'Riza S. Archival',                          'signatory',   'a0000000-0000-0000-0000-000000000002'),
  ('c0000000-0000-0000-0000-000000000003','mae.abellana@tcc.edu.ph',         crypt('admin123',gen_salt('bf')),'Mae R. Arellana, LPT',                      'signatory',   'a0000000-0000-0000-0000-000000000003'),
  ('c0000000-0000-0000-0000-000000000004','malourdes.mediano@tcc.edu.ph',    crypt('admin123',gen_salt('bf')),'Ma. Lourdes F. Mediano',                    'signatory',   'a0000000-0000-0000-0000-000000000004'),
  ('c0000000-0000-0000-0000-000000000005','jade.geraldez@tcc.edu.ph',        crypt('admin123',gen_salt('bf')),'Mr. Jade Geraldez',                         'signatory',   'a0000000-0000-0000-0000-000000000005'),
  ('c0000000-0000-0000-0000-000000000006','fritzie.formis@tcc.edu.ph',       crypt('admin123',gen_salt('bf')),'Ms. Fritzie D. Formis',                     'signatory',   'a0000000-0000-0000-0000-000000000006'),
  ('c0000000-0000-0000-0000-000000000007','jennilyn.geagonia@tcc.edu.ph',    crypt('admin123',gen_salt('bf')),'Mrs. Jennilyn D. Geagonia',                  'sas_director', 'a0000000-0000-0000-0000-000000000007'),
  ('c0000000-0000-0000-0000-000000000008','wendelyn.labajo@tcc.edu.ph',      crypt('admin123',gen_salt('bf')),'Mrs. Wendelyn Labajo',                      'signatory',   'a0000000-0000-0000-0000-000000000008'),
  ('c0000000-0000-0000-0000-000000000009','glen.tabucanon@tcc.edu.ph', crypt('admin123',gen_salt('bf')),'Glen L Tabucanon',                         'signatory',   'a0000000-0000-0000-0000-000000000009'),
  ('c0000000-0000-0000-0000-000000000010','richel.bacaltos@tcc.edu.ph',      crypt('admin123',gen_salt('bf')),'Richel N. Bacaltos, Ed.D.',                 'signatory',   'a0000000-0000-0000-0000-000000000010');

-- 6c2. Semesters — the current active semester seeds the default login view
INSERT INTO semesters (semester, academic_year, is_active)
VALUES ('2nd Semester', '2025-2026', true);

-- 6d. Clearance records — Jerame Abing: ALL 10 cleared
INSERT INTO clearance_records (student_id, category_id, status, remarks, signed_at, signed_by) VALUES
  ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','cleared',NULL,'2026-05-19 08:30:00+08','c0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','cleared',NULL,'2026-05-19 09:00:00+08','c0000000-0000-0000-0000-000000000002'),
  ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000003','cleared',NULL,'2026-05-19 09:30:00+08','c0000000-0000-0000-0000-000000000003'),
  ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000004','cleared',NULL,'2026-05-19 10:00:00+08','c0000000-0000-0000-0000-000000000004'),
  ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000005','cleared',NULL,'2026-05-19 10:30:00+08','c0000000-0000-0000-0000-000000000005'),
  ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000006','cleared',NULL,'2026-05-19 11:00:00+08','c0000000-0000-0000-0000-000000000006'),
  ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000007','cleared',NULL,'2026-05-19 11:30:00+08','c0000000-0000-0000-0000-000000000007'),
  ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000008','cleared',NULL,'2026-05-19 13:00:00+08','c0000000-0000-0000-0000-000000000008'),
  ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000009','cleared',NULL,'2026-05-19 14:00:00+08','c0000000-0000-0000-0000-000000000009'),
  ('b0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000010','cleared',NULL,'2026-05-19 15:00:00+08','c0000000-0000-0000-0000-000000000010'),

-- Maria Santos: 10 cleared
  ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000001','cleared',NULL,'2026-05-20 09:00:00+08','c0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000002','cleared',NULL,'2026-05-20 09:30:00+08','c0000000-0000-0000-0000-000000000002'),
  ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000003','cleared',NULL,'2026-05-20 10:00:00+08','c0000000-0000-0000-0000-000000000003'),
  ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000004','cleared',NULL,'2026-05-20 10:30:00+08','c0000000-0000-0000-0000-000000000004'),
  ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000005','cleared',NULL,'2026-05-20 11:00:00+08','c0000000-0000-0000-0000-000000000005'),
  ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000006','cleared',NULL,'2026-05-20 11:30:00+08','c0000000-0000-0000-0000-000000000006'),
  ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000007','cleared',NULL,'2026-05-20 13:00:00+08','c0000000-0000-0000-0000-000000000007'),
  ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000008','cleared',NULL,'2026-05-20 14:00:00+08','c0000000-0000-0000-0000-000000000008'),
  ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000009','cleared',NULL,'2026-05-20 15:00:00+08','c0000000-0000-0000-0000-000000000009'),
  ('b0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000010','cleared',NULL,'2026-05-20 16:00:00+08','c0000000-0000-0000-0000-000000000010'),

-- Pedro Reyes: 5 of 10 cleared, 2 hold, 3 pending
  ('b0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000001','cleared',NULL,'2026-05-21 09:00:00+08','c0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000002','cleared',NULL,'2026-05-21 09:30:00+08','c0000000-0000-0000-0000-000000000002'),
  ('b0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000003','hold','Missing conduct clearance slip from OSA.',NULL,NULL),
  ('b0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000004','cleared',NULL,'2026-05-21 10:30:00+08','c0000000-0000-0000-0000-000000000004'),
  ('b0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000005','cleared',NULL,'2026-05-21 11:00:00+08','c0000000-0000-0000-0000-000000000005'),
  ('b0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000006','cleared',NULL,'2026-05-21 11:30:00+08','c0000000-0000-0000-0000-000000000006'),
  ('b0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000007','hold','Unsettled library fines.',NULL,NULL),
  ('b0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000008','pending',NULL,NULL,NULL),
  ('b0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000009','pending',NULL,NULL,NULL),
  ('b0000000-0000-0000-0000-000000000003','a0000000-0000-0000-0000-000000000010','pending',NULL,NULL,NULL),

-- Ana Garcia: 7 of 10 cleared, 1 hold, 2 pending
  ('b0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000001','cleared',NULL,'2026-05-18 09:00:00+08','c0000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000002','cleared',NULL,'2026-05-18 09:30:00+08','c0000000-0000-0000-0000-000000000002'),
  ('b0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000003','cleared',NULL,'2026-05-18 10:00:00+08','c0000000-0000-0000-0000-000000000003'),
  ('b0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000004','cleared',NULL,'2026-05-18 10:30:00+08','c0000000-0000-0000-0000-000000000004'),
  ('b0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000005','cleared',NULL,'2026-05-18 11:00:00+08','c0000000-0000-0000-0000-000000000005'),
  ('b0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000006','hold','Outstanding org membership fee of PHP 200.',NULL,NULL),
  ('b0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000007','cleared',NULL,'2026-05-18 13:00:00+08','c0000000-0000-0000-0000-000000000007'),
  ('b0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000008','cleared',NULL,'2026-05-18 14:00:00+08','c0000000-0000-0000-0000-000000000008'),
  ('b0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000009','pending',NULL,NULL,NULL),
  ('b0000000-0000-0000-0000-000000000004','a0000000-0000-0000-0000-000000000010','pending',NULL,NULL,NULL),

-- Jose Ramirez: all 10 pending
  ('b0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000001','pending',NULL,NULL,NULL),
  ('b0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000002','pending',NULL,NULL,NULL),
  ('b0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000003','pending',NULL,NULL,NULL),
  ('b0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000004','pending',NULL,NULL,NULL),
  ('b0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000005','pending',NULL,NULL,NULL),
  ('b0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000006','pending',NULL,NULL,NULL),
  ('b0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000007','pending',NULL,NULL,NULL),
  ('b0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000008','pending',NULL,NULL,NULL),
  ('b0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000009','pending',NULL,NULL,NULL),
  ('b0000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000010','pending',NULL,NULL,NULL);

-- Seed records carry their owning student's semester / academic year
UPDATE clearance_records cr
SET semester = s.semester, academic_year = s.academic_year
FROM students s
WHERE s.id = cr.student_id;

-- 7. Row-Level Security
-- =============================================================================
ALTER TABLE signatory_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE students              ENABLE ROW LEVEL SECURITY;
ALTER TABLE signatories           ENABLE ROW LEVEL SECURITY;
ALTER TABLE semesters             ENABLE ROW LEVEL SECURITY;
ALTER TABLE clearance_records     ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all signatory_categories" ON signatory_categories FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all students" ON students FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all signatories" ON signatories FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all semesters" ON semesters FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "allow_all clearance_records" ON clearance_records FOR ALL USING (true) WITH CHECK (true);

-- Enable Realtime on clearance_records so student dashboards update live
-- when a signatory signs off (idempotent; safe on fresh installs too).
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE clearance_records;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
