import type { NextRequest } from 'next/server';
import { createClient as createSupabaseClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { getRequiredEnv } from '@/lib/env';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient as createServerClient } from '@/lib/supabase/server';

type RouteAuthResult = {
  supabase: SupabaseClient;
  user: User | null;
};

function extractBearerToken(request: NextRequest): string | null {
  const authHeader = request.headers.get('authorization')?.trim();
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function createBearerClient(token: string): SupabaseClient {
  return createSupabaseClient(
    getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
    getRequiredEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  );
}

export async function createRequestClient(request: NextRequest): Promise<SupabaseClient> {
  const bearerToken = extractBearerToken(request);
  if (bearerToken) {
    return createBearerClient(bearerToken);
  }
  return createServerClient();
}

export async function getRequestUser(request: NextRequest): Promise<RouteAuthResult> {
  const bearerToken = extractBearerToken(request);

  if (bearerToken) {
    const supabase = createBearerClient(bearerToken);
    const {
      data: { user },
      error,
    } = await createAdminClient().auth.getUser(bearerToken);
    if (error) {
      console.warn('[getRequestUser] bearer token rejected:', error.message);
    }
    return { supabase, user };
  }

  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}
