// supabaseClient.js — Post-init helpers for CLEARIT
// The Supabase client itself is created by the ESM <script type="module"> block
// in index.html (imports createClient from esm.sh and stores it on window.supabase).
// This file keeps the bcryptjs alias and a window.sb compatibility alias.

(function () {
  'use strict';

  if (window.supabase && typeof window.sb === 'undefined') {
    window.sb = window.supabase;
  }

  // bcryptjs UMD exposes as window.dcodeIO.bcrypt — normalize to window.bcrypt
  if (!window.bcrypt && window.dcodeIO && window.dcodeIO.bcrypt) {
    window.bcrypt = window.dcodeIO.bcrypt;
  }

  console.log('[CLEARIT] supabase ready:', !!window.supabase, '| bcryptjs ready:', !!window.bcrypt);
})();