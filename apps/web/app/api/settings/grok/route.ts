import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  GROK_BASE_URL,
  GrokAuthError,
  encryptGrokTokens,
  getGrokAccount,
  listGrokModels,
  pollGrokDeviceCode,
  requestGrokDeviceCode,
} from '@/lib/ai/grok';
import { decryptApiKey, encryptApiKey } from '@/lib/crypto/api-key';
import { getRequestUser } from '@/lib/supabase/request';

/** Used only when the Grok model catalog cannot be read. */
const FALLBACK_MODEL = 'grok-4.7';
/** auth.x.ai device codes live 30 minutes. */
const HANDLE_TTL_MS = 30 * 60_000;

/** The signed-in Grok profile, its account and the models it can switch to. */
export async function GET(request: NextRequest) {
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('llm_profiles')
    .select('id, model, api_key_encrypted')
    .eq('owner_id', user.id)
    .eq('base_url', GROK_BASE_URL)
    .limit(1)
    .maybeSingle();
  if (!profile) return NextResponse.json({ connected: false });

  try {
    const account = await getGrokAccount(profile);
    const models = account.models.includes(profile.model) ? account.models : [profile.model, ...account.models];
    return NextResponse.json({
      connected: true,
      profile_id: profile.id,
      model: profile.model,
      email: account.email,
      plan: null,
      models,
    });
  } catch (err) {
    const message = err instanceof GrokAuthError ? err.message : 'Grok sign-in check failed';
    return NextResponse.json({ connected: false, profile_id: profile.id, error: message });
  }
}

const BodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }),
  z.object({ action: z.literal('poll'), handle: z.string().min(1).max(4000) }),
]);

/**
 * Device-code "Sign in with Grok", same contract as /api/settings/chatgpt:
 * `start` → user code + verification URL; `poll` → `pending`, or the created/updated profile.
 * The device code never reaches the client: it travels inside an encrypted handle bound to the user.
 */
export async function POST(request: NextRequest) {
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });

  try {
    if (parsed.data.action === 'start') {
      const code = await requestGrokDeviceCode();
      const handle = encryptApiKey(JSON.stringify({ uid: user.id, dc: code.device_code, at: Date.now() }));
      return NextResponse.json({
        handle,
        user_code: code.user_code,
        verification_url: code.verification_url,
        interval: code.interval,
      });
    }

    let device: { uid?: string; dc?: string; at?: number };
    try {
      device = JSON.parse(decryptApiKey(parsed.data.handle));
    } catch {
      return NextResponse.json({ error: 'Invalid handle' }, { status: 400 });
    }
    if (device.uid !== user.id || !device.dc) return NextResponse.json({ error: 'Invalid handle' }, { status: 400 });
    if (Date.now() - (device.at ?? 0) > HANDLE_TTL_MS) {
      return NextResponse.json({ error: 'Grok sign-in code expired. Start again.' }, { status: 410 });
    }

    const tokens = await pollGrokDeviceCode(device.dc);
    if (!tokens) return NextResponse.json({ status: 'pending' });

    const encrypted = encryptGrokTokens(tokens);
    // Signing in again refreshes the existing Grok profile instead of adding a twin.
    const { data: existing } = await supabase
      .from('llm_profiles')
      .select('id')
      .eq('owner_id', user.id)
      .eq('base_url', GROK_BASE_URL)
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

    const [model] = await listGrokModels(tokens);
    const { count } = await supabase
      .from('llm_profiles')
      .select('id', { count: 'exact', head: true })
      .eq('owner_id', user.id);
    const { data: profile, error } = await supabase
      .from('llm_profiles')
      .insert({
        owner_id: user.id,
        name: 'Grok',
        base_url: GROK_BASE_URL,
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
    if (err instanceof GrokAuthError) return NextResponse.json({ error: err.message }, { status: 502 });
    console.error('[grok] sign-in failed', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Grok sign-in failed' }, { status: 502 });
  }
}
