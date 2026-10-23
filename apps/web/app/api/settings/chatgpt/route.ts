import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  CHATGPT_BASE_URL,
  ChatGPTAuthError,
  encryptTokens,
  listChatGPTModels,
  pollDeviceCode,
  requestDeviceCode,
} from '@/lib/ai/chatgpt';
import { decryptApiKey, encryptApiKey } from '@/lib/crypto/api-key';
import { getRequestUser } from '@/lib/supabase/request';

/** Used only when the ChatGPT model catalog cannot be read. */
const FALLBACK_MODEL = 'gpt-6-luna';

const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }),
  z.object({ action: z.literal('poll'), handle: z.string().min(1).max(4000) }),
]);

/**
 * Device-code "Sign in with ChatGPT".
 * `start` → user code + verification URL; `poll` → `pending`, or the created/updated profile.
 * The device id never reaches the client: it travels inside an encrypted handle bound to the user.
 */
export async function POST(request: NextRequest) {
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  try {
    if (parsed.data.action === 'start') {
      const code = await requestDeviceCode();
      const handle = encryptApiKey(
        JSON.stringify({ uid: user.id, id: code.device_auth_id, code: code.user_code, at: Date.now() }),
      );
      return NextResponse.json({
        handle,
        user_code: code.user_code,
        verification_url: code.verification_url,
        interval: code.interval,
      });
    }

    let device: { uid?: string; id?: string; code?: string; at?: number };
    try {
      device = JSON.parse(decryptApiKey(parsed.data.handle));
    } catch {
      return NextResponse.json({ error: 'Invalid handle' }, { status: 400 });
    }
    if (device.uid !== user.id || !device.id || !device.code) {
      return NextResponse.json({ error: 'Invalid handle' }, { status: 400 });
    }
    if (Date.now() - (device.at ?? 0) > 15 * 60_000) {
      return NextResponse.json({ error: 'ChatGPT sign-in code expired. Start again.' }, { status: 410 });
    }

    const tokens = await pollDeviceCode(device.id, device.code);
    if (!tokens) return NextResponse.json({ status: 'pending' });

    const encrypted = encryptTokens(tokens);
    // Signing in again refreshes the existing ChatGPT profile instead of adding a twin.
    const { data: existing } = await supabase
      .from('llm_profiles')
      .select('id')
      .eq('owner_id', user.id)
      .eq('base_url', CHATGPT_BASE_URL)
      .limit(1)
      .maybeSingle();
    if (existing) {
      const { data: profile, error } = await supabase
        .from('llm_profiles')
        .update({ api_key_encrypted: encrypted })
        .eq('id', existing.id)
        .eq('owner_id', user.id)
        .select('id, name, base_url, model, is_default')
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ status: 'done', profile });
    }

    const [model] = await listChatGPTModels(tokens);
    const { count } = await supabase
      .from('llm_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', user.id);
    const { data: profile, error } = await supabase
      .from('llm_profiles')
      .insert({
        owner_id: user.id,
        name: 'ChatGPT',
        base_url: CHATGPT_BASE_URL,
        model: model ?? FALLBACK_MODEL,
        api_key_encrypted: encrypted,
        extra_headers: {},
        is_default: (count ?? 0) === 0,
      })
      .select('id, name, base_url, model, is_default')
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ status: 'done', profile }, { status: 201 });
  } catch (err) {
    if (err instanceof ChatGPTAuthError) return NextResponse.json({ error: err.message }, { status: 502 });
    console.error('[chatgpt] sign-in failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'ChatGPT sign-in failed' }, { status: 502 });
  }
}
