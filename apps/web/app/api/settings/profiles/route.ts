import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { encryptApiKey, maskApiKey } from '@/lib/crypto/api-key';
import { getRequestUser } from '@/lib/supabase/request';

const ProfileSchema = z.object({
  name: z.string().min(1).max(100),
  base_url: z.string().url(),
  api_key: z.string().min(1).max(2000),
  model: z.string().min(1).max(200),
  extra_headers: z
    .record(z.string().max(2000))
    .optional()
    .default({})
    // extra_headers are stored in plaintext; the bearer credential belongs in
    // api_key (AES-256-GCM encrypted), which the LLM client sends as Authorization
    .refine((headers) => !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization'), {
      message: 'Put the Authorization credential in the API key field instead of extra_headers',
    }),
  is_default: z.boolean().optional().default(false),
});

export async function GET(request: NextRequest) {
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profiles, error } = await supabase
    .from('llm_profiles')
    .select('id, name, base_url, model, extra_headers, is_default, created_at')
    .eq('owner_id', user.id)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ profiles });
}

export async function POST(request: NextRequest) {
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = ProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { api_key, is_default, ...rest } = parsed.data;
  let encrypted: string;
  try {
    encrypted = encryptApiKey(api_key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Encryption failed';
    return NextResponse.json({ error: `Server configuration error: ${msg}` }, { status: 500 });
  }

  if (is_default) {
    await supabase
      .from('llm_profiles')
      .update({ is_default: false })
      .eq('owner_id', user.id);
  }

  const { data: profile, error } = await supabase
    .from('llm_profiles')
    .insert({
      owner_id: user.id,
      ...rest,
      api_key_encrypted: encrypted,
      is_default: is_default ?? false,
    })
    .select('id, name, base_url, model, is_default')
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ profile, masked_key: maskApiKey(api_key) }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });

  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { error } = await supabase
    .from('llm_profiles')
    .delete()
    .eq('id', id)
    .eq('owner_id', user.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
