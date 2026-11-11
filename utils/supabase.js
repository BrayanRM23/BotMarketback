const { createClient } = require('@supabase/supabase-js');

const BUCKET = process.env.SUPABASE_BUCKET || 'knowledge-files';

let client = null;

// Service role: solo se usa en el backend. Nunca exponer esta key al front.
function getSupabase() {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return client;
}

module.exports = { getSupabase, BUCKET };
