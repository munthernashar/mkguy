import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.8';
import { PUBLIC_CONFIG } from './config.js';

export const supabase = createClient(PUBLIC_CONFIG.SUPABASE_URL, PUBLIC_CONFIG.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
});
