import { describe, expect, it } from 'bun:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  IngestLeaseLostError,
  runIngestPipeline,
} from './ingest-pipeline';
import {
  claimPendingIngestJob,
  MAX_SOURCE_SNAPSHOT_BYTES,
  markFailedIfActive,
  runPendingIngestJob,
} from './ingest-job-runner';

function claimDb(result: { data: unknown; error: { code?: string; message: string } | null }) {
  const updates: Record<string, unknown>[] = [];
  const filters: unknown[] = [];
  const supabase = {
    from() {
      const builder = {
        update(values: Record<string, unknown>) {
          updates.push(values);
          return builder;
        },
        eq(_column: string, value: string) {
          filters.push(value);
          return builder;
        },
        select() {
          return builder;
        },
        maybeSingle: async () => result,
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  return { supabase, updates, filters };
}

describe('pending ingest CAS', () => {
  it('claims only pending rows and returns the new fencing token', async () => {
    const db = claimDb({ data: { id: 'job-1', attempt_count: 1 }, error: null });
    const result = await claimPendingIngestJob(db.supabase, 'job-1', 0);
    expect(result).toEqual({ claimed: true, reason: 'claimed', attemptCount: 1 });
    expect(db.updates[0]).toMatchObject({ status: 'running', attempt_count: 1 });
    expect(db.filters).toEqual(['job-1', 'pending', 0]);
  });

  it('leaves a row pending when the workspace running constraint wins the race', async () => {
    const db = claimDb({ data: null, error: { code: '23505', message: 'unique violation' } });
    await expect(claimPendingIngestJob(db.supabase, 'job-1', 3)).resolves.toEqual({
      claimed: false,
      reason: 'workspace_busy',
    });
  });
});

describe('ingest failure handling', () => {
  it('does not overwrite a pause committed while the pipeline was in flight', async () => {
    const updates: Record<string, unknown>[] = [];
    const supabase = {
      from() {
        const builder = {
          select() { return builder; },
          eq() { return builder; },
          maybeSingle: async () => ({ data: null, error: null }),
          update(values: Record<string, unknown>) {
            updates.push(values);
            return builder;
          },
        };
        return builder;
      },
    } as unknown as SupabaseClient;
    await markFailedIfActive(supabase, 'job-1', 'workspace-1', 4, new Error('provider failed with https://secret.example/key'));
    expect(updates).toEqual([{ status: 'failed', error: 'Ingest failed', finished_at: expect.any(String) }]);
  });
});

describe('pipeline fencing', () => {
  it('stops an old attempt before it can update a checkpoint', async () => {
    const updates: Record<string, unknown>[] = [];
    const builder = {
      select: () => builder,
      eq: () => builder,
      single: async () => ({
        data: {
          id: 'job-1',
          source_id: 'source-1',
          status: 'running',
          phase: 'writing',
          touched_pages: [],
          checkpoint: { written_pages: [] },
          attempt_count: 2,
          source_sha256: null,
          result: null,
        },
        error: null,
      }),
      update: (values: Record<string, unknown>) => {
        updates.push(values);
        return builder;
      },
    };
    const supabase = { from: () => builder } as unknown as SupabaseClient;
    await expect(
      runIngestPipeline({
        supabase,
        drive: {} as never,
        workspaceId: 'workspace-1',
        wikiFolderId: 'wiki-folder',
        sourceContent: 'source',
        sourceTitle: 'title',
        systemPrompt: 'prompt',
        profile: {} as never,
        jobId: 'job-1',
        attemptToken: 1,
      }),
    ).rejects.toBeInstanceOf(IngestLeaseLostError);
    expect(updates).toEqual([]);
  });
});

describe('background source bounds', () => {
  it('passes the 2 MiB limit when reloading a Drive source snapshot', async () => {
    let ingestJobLoads = 0;
    const sourceReads: Array<{ options?: { maxBytes?: number } }> = [];
    const workspace = {
      id: 'workspace-1',
      name: 'Workspace',
      drive_folder_id: 'root-folder',
      ingest_profile_id: null,
      default_profile_id: 'profile-1',
    };
    const source = {
      id: 'source-1',
      workspace_id: 'workspace-1',
      title: 'Source',
      drive_file_id: 'source-file',
    };
    const profile = {
      id: 'profile-1',
      name: 'Profile',
      base_url: 'https://provider.invalid',
      model: 'model',
      api_key_encrypted: 'encrypted',
      extra_headers: {},
      owner_id: 'owner-1',
    };
    let updating = false;
    const builder: any = {
      select() { return builder; },
      update() { updating = true; return builder; },
      eq() { return builder; },
      maybeSingle: async () => ({ data: null, error: null }),
    };
    const supabase = {
      from(table: string) {
        if (table === 'ingest_jobs') {
          builder.maybeSingle = async () => {
            if (updating) {
              updating = false;
              return { data: { id: 'job-1', attempt_count: 1 }, error: null };
            }
            const load = ingestJobLoads++;
            if (load === 0) {
              return {
                data: {
                  id: 'job-1', workspace_id: 'workspace-1', source_id: 'source-1',
                  profile_id: 'profile-1', status: 'pending', phase: 'analysis',
                  checkpoint: { written_pages: [] }, touched_pages: [], attempt_count: 0,
                },
                error: null,
              };
            }
            if (load === 1) {
              return {
                data: {
                  id: 'job-1', workspace_id: 'workspace-1', source_id: 'source-1',
                  profile_id: 'profile-1', status: 'running', phase: 'analysis',
                  checkpoint: { written_pages: [] }, touched_pages: [], attempt_count: 1,
                },
                error: null,
              };
            }
            return {
              data: {
                id: 'job-1', workspace_id: 'workspace-1', source_id: 'source-1',
                profile_id: 'profile-1', status: 'done', phase: 'done',
                checkpoint: { written_pages: [] }, touched_pages: [], attempt_count: 1,
              },
              error: null,
            };
          };
        } else if (table === 'workspaces') {
          builder.maybeSingle = async () => ({ data: workspace, error: null });
        } else if (table === 'sources') {
          builder.maybeSingle = async () => ({ data: source, error: null });
        } else if (table === 'llm_profiles') {
          builder.maybeSingle = async () => ({ data: profile, error: null });
        }
        return builder;
      },
    } as unknown as SupabaseClient;

    const result = await runPendingIngestJob({
      jobId: 'job-1',
      ownerId: 'owner-1',
      dependencies: {
        supabase,
        createDrive: async () => ({}) as never,
        findDriveFile: async (_drive, name) => (name === 'wiki' ? 'wiki-folder' : null),
        readDrive: async (_drive, _fileId, options) => {
          sourceReads.push({ options });
          return 'source body';
        },
        runPipeline: async () => [],
      },
    });

    expect(result.status).toBe('done');
    expect(sourceReads[0]?.options).toEqual({ maxBytes: MAX_SOURCE_SNAPSHOT_BYTES });
    expect(MAX_SOURCE_SNAPSHOT_BYTES).toBe(2 * 1024 * 1024);
  });
});
