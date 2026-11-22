-- clearit_delete_student.sql
-- OSAS Director: permanent student removal.
--
-- Run this once in the Supabase SQL editor.
--
-- Why it is needed:
--   clearance_records has a trigger (fn_guard_clearance_history) that blocks
--   DELETE on past terms. A plain DELETE of a student therefore fails with a
--   foreign-key / restrict_violation error when that student has history.
--   This migration teaches the guard to step aside only while the
--   delete_student_cascade() function runs, then performs the whole removal
--   atomically in one transaction.
--
-- Student authentication in CLEARIT is custom (students.password_hash), so no
-- auth.users record exists for students and none needs to be removed.

-- -----------------------------------------------------------------------------
-- 1) Allow a controlled bypass of the clearance-history guard.
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
  -- Set only inside delete_student_cascade() (transaction-local setting).
  IF current_setting('clearit.allow_student_delete', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

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

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- The existing trigger calls this function by name, so no trigger recreation
-- is required. Recreate it anyway for databases that installed an older copy.
DROP TRIGGER IF EXISTS trg_clearance_history_guard ON clearance_records;
CREATE TRIGGER trg_clearance_history_guard
  BEFORE UPDATE OR DELETE ON clearance_records
  FOR EACH ROW EXECUTE FUNCTION fn_guard_clearance_history();

-- -----------------------------------------------------------------------------
-- 2) Atomic student deletion.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION delete_student_cascade(p_student_id UUID)
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
  v_student students%ROWTYPE;
  v_table   TEXT;
BEGIN
  -- is_local => true: the setting expires with this function's transaction.
  PERFORM set_config('clearit.allow_student_delete', 'on', true);

  -- Primary child table used by the current schema.
  DELETE FROM public.clearance_records WHERE student_id = p_student_id;

  -- Legacy/alternate child table names seen in older deployments.
  FOREACH v_table IN ARRAY ARRAY['clearance_items', 'clearances', 'student_clearances'] LOOP
    IF to_regclass('public.' || v_table) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I WHERE student_id = $1', v_table)
        USING p_student_id;
    END IF;
  END LOOP;

  DELETE FROM public.students
  WHERE id = p_student_id
  RETURNING * INTO v_student;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Student not found for id %.', p_student_id
      USING ERRCODE = 'P0002';
  END IF;

  RETURN json_build_object(
    'id', v_student.id,
    'institutional_id', v_student.institutional_id,
    'full_name', v_student.full_name
  );
END;
$$;

-- RLS still applies (SECURITY INVOKER is the default). The OSAS Director is
-- identified in app code; this grant only makes the function callable.
REVOKE ALL ON FUNCTION delete_student_cascade(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_student_cascade(UUID) TO anon, authenticated;
