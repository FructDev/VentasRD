// src/lib/supabase/admin.ts
// Cliente de Supabase con service role — SOLO usar en API routes (server-side).
// Nunca importar desde componentes 'use client'.
import { createClient } from '@supabase/supabase-js';

export function createAdminClient() {
    return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        }
    );
}
