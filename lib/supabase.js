import { createClient } from '@supabase/supabase-js';

// Supabase client for CarpoolBoard Prototype 4.
//
// Values come from .env.local (ignored by Git). Expo inlines EXPO_PUBLIC_*
// variables at build time, so they must be read with direct
// `process.env.EXPO_PUBLIC_...` references (no destructuring).
//
// Only the publishable key is used here — never a service_role/secret key.
// This prototype does NOT use Supabase Auth: accounts are rows in the
// `profiles` table identified by email, and the prototype's anon RLS
// policies decide what the app may read and write. So there's no session to
// store, refresh, or read from a URL.
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error(
    'Missing Supabase config. Set EXPO_PUBLIC_SUPABASE_URL and ' +
      'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local, then restart Expo.'
  );
}

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});
