-- =============================================================================
-- CLEARIT — E-Signature Migration
-- Target: LIVE database (Supabase Dashboard → SQL Editor → New query → Run)
--
-- Run this AFTER clearit_academic_status_migration.sql. It is idempotent,
-- transactional, and deletes no clearance history.
--
-- What this does:
--   1. Creates the public "signatures" Storage bucket that holds the images
--   2. Adds signatories.signature_url      — the officer's CURRENT signature URL
--   3. Adds clearance_records.signature_url — the signature URL SNAPSHOT taken at
--      the moment of approval
--   4. Rewrites fn_approve_clearance so the approval and the signature snapshot
--      land in the SAME statement, server-side
--   5. Rewrites fn_flag_clearance so a requirement placed On Hold also drops its
--      signature (a hold is not a signed act)
--   6. Rebuilds v_clearance_details exposing the snapshot
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
--   signature_url holds a PUBLIC URL into a Supabase Storage bucket:
--     https://<project>.supabase.co/storage/v1/object/public/signatures/signatory-<uuid>-<version>.png
--   The image bytes live in Storage; the column and each clearance record carry
--   only that short URL. Nothing large is stored in the database any more.
--
--   EVERY DRAW GETS ITS OWN OBJECT, and only the newest is recorded on the
--   signatory row. That is what makes the snapshot above meaningful: a clearance
--   already handed out keeps resolving the exact bytes it was signed with, so an
--   officer who re-draws cannot retroactively change an approval. The cost is
--   one object per draw, and "remove my signature" has to delete all of them -
--   including the one a past clearance still points at, which then prints an
--   empty line. That is the intended trade: an officer who withdraws their
--   signature has asked for it to be gone.
--
--   Note the object key is NOT <uuid>.png with an overwrite. A stable key per
--   officer would be tidier, but a re-draw would then rewrite the image on every
--   clearance that officer ever approved, which is precisely the audit-trail
--   defect the snapshot exists to prevent.
--
--   The bucket is PUBLIC on purpose. A private bucket would need short-lived
--   signed URLs, and an official clearance form has to keep rendering when it is
--   reprinted days later. The object key embeds the signatory's UUID, which is
--   not published anywhere, so the image is not discoverable by guessing - only
--   someone already holding the URL can fetch it. No Storage READ policy is
--   needed for a public bucket, so this migration creates the bucket and
--   nothing else.
--
--   A legacy base64 data URL is still accepted by the app: a signature saved
--   before the move to Storage keeps rendering, and its next save converts it.
--
-- SAFETY NOTES
--   * Nothing in clearance_records is UPDATEd or DELETEd except through the two
--     RPCs, which only ever touch the active term's own row. The read-only
--     history trigger from the academic-status migration stays in force.
--   * The CHECK constraints cap signature_url at 400 000 characters. A URL is
--     ~150, so this is a runaway guard rather than a real limit - and the
--     generous ceiling is what still lets a legacy base64 value stay valid.
--   * The bucket itself is capped at 5 MB per object and accepts only PNG and
--     JPEG, so even a client that skips the app's own 4 MB check cannot bloat
--     storage.
--   * A signatory with no signature on file can still approve. The approval
--     succeeds and snapshots NULL; the printable form simply omits the image and
--     leaves the signature line blank, exactly as it does today.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1) The public "signatures" Storage bucket.
--
--    Best effort by design: the SQL editor's role is not guaranteed to be
--    allowed to write storage.buckets, and this box has no dashboard access. If
--    the insert cannot run, the rest of the migration still applies (the columns
--    are what the app needs) and the WARNING below tells the operator exactly
--    what to click. Saving a signature also names the bucket in its own error,
--    so the app degrades to a clear message rather than a silent failure.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_have_storage boolean := false;
  v_bucket       text    := 'signatures';
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema = 'storage' AND table_name = 'buckets')
    INTO v_have_storage;

  IF NOT v_have_storage THEN
    RAISE WARNING 'storage schema not present (not a Supabase project?): skipping the "%" bucket.', v_bucket;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = v_bucket) THEN
    -- Already there. Make sure it is PUBLIC, because a private bucket would
    -- make every saved signature fail to load on the printable form. The
    -- report distinguishes "fine as it was" from "just repaired", so the
    -- operator reading the SQL editor output is not misled into thinking
    -- nothing was touched.
    DECLARE
      v_was_public boolean;
    BEGIN
      SELECT b.public INTO v_was_public FROM storage.buckets b WHERE b.id = v_bucket;

      UPDATE storage.buckets
         SET public = true,
             file_size_limit = COALESCE(file_size_limit, 5242880),
             allowed_mime_types = COALESCE(allowed_mime_types, ARRAY['image/png','image/jpeg'])
       WHERE id = v_bucket;

      IF v_was_public THEN
        RAISE NOTICE 'Storage bucket "%" already exists and is public.', v_bucket;
      ELSE
        RAISE WARNING 'Storage bucket "%" existed but was PRIVATE - it is now public. '
                      'A private bucket would have made every saved signature fail to load '
                      'on the printable form.', v_bucket;
      END IF;
    END;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (v_bucket, v_bucket, true, 5242880, ARRAY['image/png','image/jpeg'])
    ON CONFLICT (id) DO NOTHING;
    RAISE NOTICE 'Created public storage bucket "%" (5 MB cap, PNG/JPEG only).', v_bucket;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE WARNING
      'Could not create the "%" storage bucket (%). Create it in the dashboard: '
      'Storage -> New bucket -> name it "%" -> tick "Public bucket". '
      'Signature saving will report this until it exists.',
      v_bucket, SQLERRM, v_bucket;
  END;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2) Signature columns
-- -----------------------------------------------------------------------------
ALTER TABLE signatories    ADD COLUMN IF NOT EXISTS signature_url TEXT;
ALTER TABLE clearance_records ADD COLUMN IF NOT EXISTS signature_url TEXT;

-- -----------------------------------------------------------------------------
-- 3) Size guards.
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
-- 4) fn_approve_clearance — approval and signature snapshot in one statement.
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
-- 5) fn_flag_clearance — a requirement put On Hold carries no signature.
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
-- 6) v_clearance_details — expose the snapshot.
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
