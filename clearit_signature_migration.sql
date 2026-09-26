-- =============================================================================
-- CLEARIT — E-Signature Migration
-- Target: LIVE database (Supabase Dashboard → SQL Editor → New query → Run)
--
-- Run this AFTER clearit_academic_status_migration.sql. It is idempotent,
-- transactional, and deletes no clearance history.
--
-- What this does:
--   1. Adds signatories.signature_url      — the signatory's CURRENT signature
--   2. Adds clearance_records.signature_url — the signature SNAPSHOT taken at the
--      moment of approval
--   3. Rewrites fn_approve_clearance so the approval and the signature snapshot
--      land in the SAME statement, server-side
--   4. Rewrites fn_flag_clearance so a requirement placed On Hold also drops its
--      signature (a hold is not a signed act)
--   5. Rebuilds v_clearance_details exposing the snapshot
--
-- WHY THE SIGNATURE IS SNAPSHED ONTO THE CLEARANCE RECORD
--   Storing the signature only on the signatory and reading it back at print
--   time would mean that if a signatory ever re-draws their signature, EVERY
--   clearance they ever approved would silently re-render with the new image —
--   including documents already handed out and already carrying an
--   "OFFICIAL VERIFICATION" QR code. That is an audit-trail defect, not a
--   cosmetic one. So the signature image is copied onto the clearance record at
--   approval time and the printable form reads the snapshot, never the live one.
--
-- STORAGE FORMAT
--   signature_url holds a data URL: "data:image/png;base64,....". This is
--   deliberate. A Supabase Storage bucket would need a public bucket plus storage
--   policies created through the dashboard, and the printable form is written
--   into a separate window via document.write() — a data URL renders there with
--   no network round-trip and no chance of a broken image on an official
--   document. Postgres TEXT is 1 GB, so the payload is not a storage concern.
--
-- SAFETY NOTES
--   * Nothing in clearance_records is UPDATEd or DELETEd except through the two
--     RPCs, which only ever touch the active term's own row. The read-only
--     history trigger from the academic-status migration stays in force.
--   * The CHECK constraints cap a stored signature at 400 000 characters
--     (~300 KB of PNG) so a runaway upload cannot bloat the row.
--   * A signatory with no signature on file can still approve. The approval
--     succeeds and snapshots NULL; the printable form simply omits the image and
--     leaves the signature line blank, exactly as it does today.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1) Signature columns
-- -----------------------------------------------------------------------------
ALTER TABLE signatories    ADD COLUMN IF NOT EXISTS signature_url TEXT;
ALTER TABLE clearance_records ADD COLUMN IF NOT EXISTS signature_url TEXT;

-- -----------------------------------------------------------------------------
-- 2) Size guards.
--    A trimmed signature PNG lands around 5-40 KB of base64; the 400 000 char
--    cap is roughly 10x headroom while still refusing an unbounded payload.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_signatories_signature_len') THEN
    ALTER TABLE signatories ADD CONSTRAINT chk_signatories_signature_len
      CHECK (signature_url IS NULL OR length(signature_url) <= 400000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_clearance_signature_len') THEN
    ALTER TABLE clearance_records ADD CONSTRAINT chk_clearance_signature_len
      CHECK (signature_url IS NULL OR length(signature_url) <= 400000);
  END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3) fn_approve_clearance — approval and signature snapshot in one statement.
--
--    The signature is read from the signatory row INSIDE the RPC rather than
--    being passed in by the browser. That keeps the snapshot atomic with the
--    approval and means a client cannot attach an image of somebody else's
--    choosing. Re-approving always re-reads the signatory's current signature,
--    because a fresh click is a fresh signing act.
-- -----------------------------------------------------------------------------
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
  INSERT INTO clearance_records (student_id, category_id, status, remarks, signed_at, signed_by, semester, academic_year, signature_url)
  VALUES (
    p_student_id, p_category_id, 'cleared', NULL, now(), p_signatory_id, p_semester, p_academic_year,
    (SELECT sg.signature_url FROM signatories sg WHERE sg.id = p_signatory_id)
  )
  ON CONFLICT (student_id, semester, academic_year, category_id) DO UPDATE
  SET status='cleared', remarks=NULL, signed_at=now(), signed_by=p_signatory_id,
      signature_url=(SELECT sg.signature_url FROM signatories sg WHERE sg.id = p_signatory_id);
END;
$$;

-- -----------------------------------------------------------------------------
-- 4) fn_flag_clearance — a requirement put On Hold carries no signature.
--    The record keeps signed_by (who raised the hold) but drops signed_at and
--    the signature image, so nothing can render a signature over a hold.
-- -----------------------------------------------------------------------------
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
  INSERT INTO clearance_records (student_id, category_id, status, remarks, signed_at, signed_by, semester, academic_year, signature_url)
  VALUES (
    p_student_id, p_category_id, 'hold', p_remarks, NULL, p_signatory_id, p_semester, p_academic_year, NULL
  )
  ON CONFLICT (student_id, semester, academic_year, category_id) DO UPDATE
  SET status='hold', remarks=p_remarks, signed_at=NULL,
      signed_by=p_signatory_id, signature_url=NULL;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5) v_clearance_details — expose the snapshot.
--
--    DROP + CREATE rather than CREATE OR REPLACE so the output is identical no
--    matter which earlier migrations ran. Every column the academic-status
--    migration added (year_level, section_block, academic_status) is carried
--    forward here; dropping one would silently break the Manage Students
--    filters, which select them by name.
--
--    The view exposes cr.signature_url, NOT sg.signature_url, so the printable
--    form always renders the signature that was in force when the requirement
--    was actually signed.
-- -----------------------------------------------------------------------------
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
  cr.signature_url AS signature_url,
  s.year_level, s.section_block, s.academic_status
FROM clearance_records cr
JOIN students s              ON s.id  = cr.student_id
JOIN signatory_categories sc ON sc.id = cr.category_id
LEFT JOIN signatories sg     ON sg.id = cr.signed_by;

COMMIT;

-- =============================================================================
-- After running this, refresh the page (Ctrl+Shift+R) and every signatory will
-- see a "Digital Signature" button in the signatory portal header.
-- =============================================================================
