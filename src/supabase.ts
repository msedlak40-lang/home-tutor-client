import { createClient } from "@supabase/supabase-js";

// 🔧 Fill these with your Supabase project values (Settings → API)
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://udlqdtktxqrzmmuqwvgp.supabase.co";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkbHFkdGt0eHFyem1tdXF3dmdwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkwODM5NzYsImV4cCI6MjA3NDY1OTk3Nn0.YtsdObdahDdU5knCfl5iQouizJRw2c0bWglb5wWyv58";

// Frontend should ONLY use the anon public key.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
