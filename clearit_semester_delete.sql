-- clearit_semester_delete.sql
-- OSAS Director: safe semester edit + permanent semester deletion.
--
-- Run this once in the Supabase SQL editor.
--
-- Why it is needed:
--   fn_guard_clearance_history() permanently allows DELETE on every term,
--   including past ones, while INSERT/UPDATE stay locked to the active term.
--   Editing a past term still needs a transaction-local bypass for UPDATE;
--   that flag is set only inside fn_update_semester_full() below. Deleting a
--   term needs no bypass at all.

-- -----------------------------------------------------------------------------
-- 1) History guard: writes locked, deletes always allowed
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_guard_clearance_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_active_sem TEXT;
  v_active_ay  TEXT;
  v_term_sem   TEXT;
  v_term_ay    TEXT;
BEGIN
  -- Deleting history is ALWAYS permitted, past terms included. This runs before
  -- any active-term lookup so no inactive DELETE can be rejected here.
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  -- Editing a past term is allowed only inside fn_update_semester_full(), which
  -- sets this transaction-local flag. It has no effect on DELETE (already allowed).
  IF current_setting('clearit.allow_semester_manage', true) = 'on' THEN
    RETURN NEW;
  END IF;

  -- INSERT/UPDATE stay locked to the active term. UPDATE is judged by the
  -- stored term (OLD); INSERT has no OLD row, so it is judged by NEW.
  IF TG_OP = 'UPDATE' THEN
    v_term_sem := COALESCE(OLD.semester, '');
    v_term_ay  := COALESCE(OLD.academic_year, '');
  ELSE
    v_term_sem := COALESCE(NEW.semester, '');
    v_term_ay  := COALESCE(NEW.academic_year, '');
  END IF;

  SELECT semester, academic_year INTO v_active_sem, v_active_ay
  FROM semesters
  WHERE is_active
  LIMIT 1;

  -- With no active term configured there is nothing to protect, so allow it.
  IF v_active_sem IS NOT NULL
     AND (v_term_sem <> v_active_sem OR v_term_ay <> v_active_ay) THEN
    RAISE EXCEPTION
      'Clearance history is read-only: % / % cannot be modified. Only the active term (% / %) may be changed.',
      v_term_sem, v_term_ay, v_active_sem, v_active_ay
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clearance_history_guard ON clearance_records;
CREATE TRIGGER trg_clearance_history_guard
  BEFORE UPDATE OR DELETE ON clearance_records
  FOR EACH ROW EXECUTE FUNCTION fn_guard_clearance_history();

-- -----------------------------------------------------------------------------
-- 2) Edit a term everywhere it appears — OSAS Director only
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_update_semester_full(
  p_semester_id       UUID,
  p_semester          TEXT,
  p_academic_year     TEXT,
  p_old_semester      TEXT,
  p_old_academic_year TEXT,
  p_sas_email         TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM signatories
                 WHERE email = p_sas_email AND role = 'sas_director') THEN
    RAISE EXCEPTION 'Forbidden: only the SAS Director can edit semesters.';
  END IF;
  IF p_semester NOT IN ('1st Semester','2nd Semester','Summer / Midyear') THEN
    RAISE EXCEPTION 'Invalid semester name. Use 1st Semester, 2nd Semester, or Summer / Midyear.';
  END IF;
  IF NOT p_academic_year ~ '^[0-9]{4}-[0-9]{4}$' THEN
    RAISE EXCEPTION 'Academic year must be in YYYY-YYYY format, e.g. 2026-2027.';
  END IF;

  -- Terms that only exist in clearance_records have no id yet: register them
  -- under their current name before renaming, so nothing is silently dropped.
  v_id := p_semester_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM semesters
    WHERE semester = p_old_semester AND academic_year = p_old_academic_year;
    IF v_id IS NULL THEN
      INSERT INTO semesters (semester, academic_year)
      VALUES (p_old_semester, p_old_academic_year)
      RETURNING id INTO v_id;
    END IF;
  END IF;

  -- UPDATE of a past term still needs the guard's transaction-local bypass.
  PERFORM set_config('clearit.allow_semester_manage', 'on', true);

  UPDATE clearance_records
     SET semester = p_semester, academic_year = p_academic_year
   WHERE semester = p_old_semester AND academic_year = p_old_academic_year;

  -- Keep student term tags aligned so the renamed term still appears on the
  -- student and signatory dashboards.
  UPDATE students
     SET semester = p_semester, academic_year = p_academic_year
   WHERE semester = p_old_semester AND academic_year = p_old_academic_year;

  UPDATE semesters
     SET semester = p_semester, academic_year = p_academic_year
   WHERE id = v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3) Delete a term and every clearance record belonging to it — OSAS only
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_delete_semester_cascade(
  p_semester_id   UUID,
  p_semester      TEXT,
  p_academic_year TEXT,
  p_sas_email     TEXT
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_active       BOOLEAN := false;
  v_deleted      INTEGER := 0;
  v_removed_term INTEGER := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM signatories
                 WHERE email = p_sas_email AND role = 'sas_director') THEN
    RAISE EXCEPTION 'Forbidden: only the SAS Director can delete semesters.';
  END IF;

  SELECT true INTO v_active FROM semesters
  WHERE is_active
    AND ((p_semester_id IS NOT NULL AND id = p_semester_id)
      OR (semester = p_semester AND academic_year = p_academic_year))
  LIMIT 1;

  IF v_active THEN
    RAISE EXCEPTION 'Cannot delete the currently Active semester. Set another semester active first.';
  END IF;

  -- DELETE is permanently allowed by the guard; no bypass needed.

  DELETE FROM clearance_records
  WHERE semester = p_semester AND academic_year = p_academic_year;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF p_semester_id IS NOT NULL THEN
    DELETE FROM semesters WHERE id = p_semester_id;
  ELSE
    DELETE FROM semesters
    WHERE semester = p_semester AND academic_year = p_academic_year;
  END IF;
  GET DIAGNOSTICS v_removed_term = ROW_COUNT;

  RETURN json_build_object(
    'deleted_records', v_deleted,
    'removed_term',    v_removed_term,
    'semester',        p_semester,
    'academic_year',   p_academic_year
  );
END;
$$;

REVOKE ALL ON FUNCTION fn_update_semester_full(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_update_semester_full(UUID, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

REVOKE ALL ON FUNCTION fn_delete_semester_cascade(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_delete_semester_cascade(UUID, TEXT, TEXT, TEXT) TO anon, authenticated;
