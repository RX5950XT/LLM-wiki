import { NextRequest, NextResponse, after } from 'next/server';
import { z } from 'zod';
import type { drive_v3 } from 'googleapis';
import { writeDriveFile, findFile, readDriveFile } from '@/lib/drive/client';
import { createWorkspaceForUser } from '@/lib/workspaces/manage';
import { getRequestUser } from '@/lib/supabase/request';
import {
  createDriveClientForUser,
  GOOGLE_DRIVE_REAUTH_MESSAGE,
  isGoogleDriveAuthError,
} from '@/lib/google/drive-auth';

export const maxDuration = 300;
import { generateText } from 'ai';
import { urlToMarkdown } from '@/lib/fetch/url-to-markdown';
import { createLLMClient } from '@/lib/ai/client';
import { runIngestPipeline } from '@/lib/ai/ingest-pipeline';
import { loadDefaultProfileId } from '@/lib/ai/profile';
import { getDefaultPrompt } from '@llm-wiki/prompts';
import { resolveUiLocaleFromRequest } from '@/lib/i18n/ui-locale';

// Matches the 2 MB client-side caps on web and Android file ingest
const MAX_TEXT_LENGTH = 2 * 1024 * 1024;

const TargetFields = {
  // Explicit target, or auto_route + fallback_workspace_id (AI picks the target)
  workspace_id: z.string().uuid().optional(),
  auto_route: z.boolean().optional(),
  fallback_workspace_id: z.string().uuid().optional(),
  profile_id: z.string().uuid().nullish(),
};

const IngestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    url: z.string().url().max(2048),
    ...TargetFields,
  }),
  z.object({
    kind: z.literal('text'),
    title: z.string().min(1).max(300),
    content: z.string().min(1).max(MAX_TEXT_LENGTH),
    ...TargetFields,
  }),
]);

/** Scaffolding every workspace has; not evidence that it holds any knowledge. */
const SCAFFOLDING_SLUGS = ['index.md', 'log.md'];

/** Ceiling on router-created workspaces, so a misfiring router can't shard the base. */
const MAX_AUTO_WORKSPACES = 12;

/** `NEW: <name>` — the router's way of saying nothing existing fits. */
function parseNewWorkspaceName(text: string): string | null {
  const match = /NEW\s*[:：]\s*(.+)/i.exec(text);
  if (!match) return null;
  const name = (match[1]?.split('\n')[0] ?? '')
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .trim()
    .slice(0, 50);
  return name.length >= 2 ? name : null;
}

/**
 * Pick the best-fitting workspace for a piece of content with one small LLM call,
 * creating a new workspace when the content belongs to none of them. Falls back to
 * `fallbackId` on any failure — routing must never block an ingest.
 */
async function routeToWorkspace(
  supabase: Awaited<ReturnType<typeof getRequestUser>>['supabase'],
  drive: drive_v3.Drive,
  userId: string,
  profileRow: Parameters<typeof createLLMClient>[0],
  sourceTitle: string,
  sourceContent: string,
  fallbackId: string,
  locale: string,
): Promise<{ workspaceId: string; created: boolean }> {
  const stay = { workspaceId: fallbackId, created: false };

  const { data: workspaces } = await supabase
    .from('workspaces')
    .select('id, name')
    .eq('owner_id', userId);
  if (!workspaces?.length) return stay;

  const { data: pageRows } = await supabase
    .from('pages')
    .select('workspace_id, title')
    .in('workspace_id', workspaces.map((w) => w.id))
    .eq('zone', 'wiki')
    .not('slug', 'in', `(${SCAFFOLDING_SLUGS.join(',')})`)
    .order('updated_at', { ascending: false })
    .limit(1200);

  // An empty base has nothing to route against — the first import stays put rather
  // than spawning a second workspace next to the empty one.
  if (!pageRows?.length) return stay;

  const titlesByWorkspace = new Map<string, string[]>();
  for (const row of pageRows) {
    const list = titlesByWorkspace.get(row.workspace_id) ?? [];
    if (list.length < 40 && row.title) list.push(row.title);
    titlesByWorkspace.set(row.workspace_id, list);
  }

  const workspaceSummary = workspaces
    .map((w) => `- id: ${w.id}\n  name: ${w.name}\n  pages: ${(titlesByWorkspace.get(w.id) ?? []).join(', ') || '(empty)'}`)
    .join('\n');

  const canCreate = workspaces.length < MAX_AUTO_WORKSPACES;

  try {
    const model = createLLMClient(profileRow);
    const { text } = await generateText({
      model,
      system:
        'You file incoming content into the knowledge workspace where it belongs. Answer with a single line and nothing else.',
      prompt: `Workspaces:\n${workspaceSummary}\n\nContent title: ${sourceTitle}\nContent excerpt:\n${sourceContent.slice(0, 1500)}\n\nReply with EITHER the id of the workspace this content belongs in${
        canCreate
          ? `, OR "NEW: <short workspace name>" if its subject is clearly outside every workspace above. Strongly prefer an existing workspace — related content belongs together, and a new workspace is only right when nothing above covers this subject at all. Name it in the user's language (${locale}).`
          : '. You must pick one of the ids above.'
      }`,
    });

    const candidate = workspaces.find((w) => text.includes(w.id));
    if (candidate) return { workspaceId: candidate.id, created: false };

    const newName = canCreate ? parseNewWorkspaceName(text) : null;
    if (!newName) return stay;

    // Two files of the same new subject in one batch must not create two workspaces.
    const sameName = workspaces.find(
      (w) => w.name.trim().toLowerCase() === newName.toLowerCase(),
    );
    if (sameName) return { workspaceId: sameName.id, created: false };

    const created = await createWorkspaceForUser(drive, userId, newName, locale);
    return created.ok ? { workspaceId: created.id, created: true } : stay;
  } catch {
    return stay;
  }
}

export async function POST(request: NextRequest) {
  const locale = resolveUiLocaleFromRequest(request);
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const parsed = IngestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const autoRoute = parsed.data.auto_route === true;
  const explicitWorkspaceId = parsed.data.workspace_id ?? null;
  const fallbackWorkspaceId = parsed.data.fallback_workspace_id ?? explicitWorkspaceId;
  if (!autoRoute && !explicitWorkspaceId) {
    return NextResponse.json({ error: 'workspace_id required' }, { status: 400 });
  }
  if (autoRoute && !fallbackWorkspaceId) {
    return NextResponse.json({ error: 'fallback_workspace_id required with auto_route' }, { status: 400 });
  }

  const loadWorkspace = async (id: string) =>
    supabase
      .from('workspaces')
      .select('id, name, drive_folder_id, ingest_profile_id, default_profile_id')
      .eq('id', id)
      .eq('owner_id', user.id)
      .single();

  const loadProfileRow = async (id: string) =>
    supabase
      .from('llm_profiles')
      .select('id, name, base_url, model, api_key_encrypted, extra_headers, extra_headers_encrypted, owner_id')
      .eq('id', id)
      .eq('owner_id', user.id)
      .single();

  // Ownership-gate BEFORE any outbound fetch, so an attacker can't drive the
  // server to fetch arbitrary URLs by passing a workspace they don't own.
  const gateWorkspaceId = autoRoute ? fallbackWorkspaceId! : explicitWorkspaceId!;
  const { data: gateWorkspace } = await loadWorkspace(gateWorkspaceId);
  if (!gateWorkspace) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });

  // Resolve the requested profile override once (ownership-checked)
  let overrideProfileId: string | null = null;
  if (parsed.data.profile_id) {
    const { data: overriddenProfile } = await supabase
      .from('llm_profiles')
      .select('id')
      .eq('id', parsed.data.profile_id)
      .eq('owner_id', user.id)
      .single();
    if (overriddenProfile) overrideProfileId = overriddenProfile.id;
  }

  // Fetch source content (auto routing needs it) — only after ownership passes
  let sourceContent: string;
  let sourceTitle: string;
  let sourceUrl: string | undefined;

  if (parsed.data.kind === 'url') {
    try {
      const article = await urlToMarkdown(parsed.data.url);
      sourceContent = article.markdown;
      sourceTitle = article.title;
      sourceUrl = parsed.data.url;
    } catch (err) {
      return NextResponse.json(
        { error: `Failed to fetch URL: ${err instanceof Error ? err.message : 'unknown error'}` },
        { status: 422 },
      );
    }
  } else {
    sourceContent = parsed.data.content;
    sourceTitle = parsed.data.title;
  }

  // Drive client first: routing may need to create the target workspace.
  let drive: Awaited<ReturnType<typeof createDriveClientForUser>>;
  try {
    drive = await createDriveClientForUser(user.id);
  } catch (error) {
    if (isGoogleDriveAuthError(error)) {
      return NextResponse.json(
        { error: error.message || GOOGLE_DRIVE_REAUTH_MESSAGE },
        { status: 403 },
      );
    }
    throw error;
  }

  // Resolve target workspace (auto routing uses the gate workspace's profile)
  let workspace_id: string;
  let routedWorkspaceName: string | undefined;
  let routedWorkspaceCreated = false;
  let workspace: NonNullable<Awaited<ReturnType<typeof loadWorkspace>>['data']>;

  if (autoRoute) {
    const routingProfileId =
      overrideProfileId ??
      gateWorkspace.ingest_profile_id ??
      gateWorkspace.default_profile_id ??
      (await loadDefaultProfileId(supabase, user.id));
    if (!routingProfileId) {
      return NextResponse.json(
        { error: 'No LLM profile configured. Go to Settings to add one.' },
        { status: 422 },
      );
    }
    const { data: routingProfile } = await loadProfileRow(routingProfileId);
    if (!routingProfile) return NextResponse.json({ error: 'LLM profile not found' }, { status: 404 });

    const routing = await routeToWorkspace(
      supabase,
      drive,
      user.id,
      routingProfile as Parameters<typeof createLLMClient>[0],
      sourceTitle,
      sourceContent,
      gateWorkspace.id,
      locale,
    );
    workspace_id = routing.workspaceId;
    routedWorkspaceCreated = routing.created;
    // routeToWorkspace only ever returns an id from the user's own workspaces,
    // but re-verify to be safe (and to get the routed workspace's profile row).
    if (workspace_id === gateWorkspace.id) {
      workspace = gateWorkspace;
    } else {
      const { data: routed } = await loadWorkspace(workspace_id);
      if (!routed) return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
      workspace = routed;
    }
    routedWorkspaceName = workspace.name;
  } else {
    workspace_id = explicitWorkspaceId!;
    workspace = gateWorkspace;
  }

  // A freshly created workspace only gets a profile if the user has a default one;
  // fall back to the workspace the import was triggered from so routing can never
  // turn a working import into "No LLM profile configured".
  const profileId =
    overrideProfileId ??
    workspace.ingest_profile_id ??
    workspace.default_profile_id ??
    gateWorkspace.ingest_profile_id ??
    gateWorkspace.default_profile_id ??
    (await loadDefaultProfileId(supabase, user.id));

  if (!profileId) {
    return NextResponse.json(
      { error: 'No LLM profile configured. Go to Settings to add one.' },
      { status: 422 }
    );
  }

  const { data: profile } = await loadProfileRow(profileId);
  if (!profile) return NextResponse.json({ error: 'LLM profile not found' }, { status: 404 });

  // Store raw source in Drive — resolve its folders in parallel
  const [sourcesFolderId, wikiFolderId, schemaFolderId] = await Promise.all([
    findFile(drive, 'sources', workspace.drive_folder_id, 'application/vnd.google-apps.folder'),
    findFile(drive, 'wiki', workspace.drive_folder_id, 'application/vnd.google-apps.folder'),
    findFile(drive, '_schema', workspace.drive_folder_id, 'application/vnd.google-apps.folder'),
  ]);
  if (!sourcesFolderId) {
    return NextResponse.json({ error: 'Drive sources folder not found' }, { status: 500 });
  }
  if (!wikiFolderId) {
    return NextResponse.json({ error: 'Drive wiki folder not found' }, { status: 500 });
  }

  const sourceFileId = await writeDriveFile(drive, sourceContent, {
    name: `${Date.now()}.md`,
    parentId: sourcesFolderId,
  });

  // Create source record
  const { data: source } = await supabase
    .from('sources')
    .insert({
      workspace_id,
      kind: parsed.data.kind,
      title: sourceTitle,
      url: sourceUrl ?? null,
      drive_file_id: sourceFileId,
    })
    .select('id')
    .single();
  if (!source) return NextResponse.json({ error: 'Failed to create source record' }, { status: 500 });

  // Load schema prompt from Drive _schema/ingest.md (user may have customized it)
  let systemPrompt = getDefaultPrompt('ingest', locale);
  if (schemaFolderId) {
    const ingestFileId = await findFile(drive, 'ingest.md', schemaFolderId);
    if (ingestFileId) {
      systemPrompt = await readDriveFile(drive, ingestFileId);
    }
  }

  // Create ingest job already in 'running' state so a crash can never
  // leave an unsweepable 'pending' row without started_at
  const { data: job } = await supabase
    .from('ingest_jobs')
    .insert({
      workspace_id,
      source_id: source.id,
      status: 'running',
      profile_id: profileId,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (!job) return NextResponse.json({ error: 'Failed to create ingest job' }, { status: 500 });

  // Run the LLM pipeline AFTER responding — clients poll GET /api/ingest?job_id=
  // instead of holding a connection open for up to 300s (Vercel Fluid Compute
  // keeps the function alive until after() work completes).
  after(async () => {
    try {
      await runIngestPipeline({
        supabase,
        drive,
        workspaceId: workspace_id,
        wikiFolderId,
        sourceContent,
        sourceTitle,
        systemPrompt,
        profile: profile as Parameters<typeof runIngestPipeline>[0]['profile'],
        jobId: job.id,
      });

      await supabase
        .from('sources')
        .update({ ingested_at: new Date().toISOString() })
        .eq('id', source.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await supabase
        .from('ingest_jobs')
        .update({
          status: 'failed',
          error: message,
          finished_at: new Date().toISOString(),
        })
        .eq('id', job.id);
    }
  });

  return NextResponse.json(
    {
      jobId: job.id,
      status: 'running',
      ...(routedWorkspaceName
        ? {
            routed_workspace_id: workspace_id,
            routed_workspace_name: routedWorkspaceName,
            routed_workspace_created: routedWorkspaceCreated,
          }
        : {}),
    },
    { status: 202 },
  );
}

// A running job older than this can no longer be alive (maxDuration 300s + buffer)
const STALE_JOB_MS = 8 * 60 * 1000;

export async function GET(request: NextRequest) {
  const { supabase, user } = await getRequestUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const jobIdParsed = z.string().uuid().safeParse(request.nextUrl.searchParams.get('job_id'));
  if (!jobIdParsed.success) {
    return NextResponse.json({ error: 'job_id query param required' }, { status: 400 });
  }

  // RLS scopes ingest_jobs to workspaces owned by the requesting user
  const { data: job } = await supabase
    .from('ingest_jobs')
    .select('id, status, error, touched_pages, started_at, finished_at')
    .eq('id', jobIdParsed.data)
    .single();
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });

  if (
    (job.status === 'running' || job.status === 'pending') &&
    job.started_at &&
    Date.now() - new Date(job.started_at).getTime() > STALE_JOB_MS
  ) {
    const error = 'Ingest timed out';
    await supabase
      .from('ingest_jobs')
      .update({ status: 'failed', error, finished_at: new Date().toISOString() })
      .eq('id', job.id);
    return NextResponse.json({ jobId: job.id, status: 'failed', error, touched_pages: [] });
  }

  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    error: job.error,
    touched_pages: job.touched_pages ?? [],
  });
}
