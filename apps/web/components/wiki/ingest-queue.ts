export const INGEST_STATUSES = ['pending', 'running', 'paused', 'done', 'failed'] as const;
export type IngestQueueStatus = (typeof INGEST_STATUSES)[number];

export const INGEST_PHASES = ['analysis', 'writing', 'review', 'done'] as const;
export type IngestQueuePhase = (typeof INGEST_PHASES)[number];

export type IngestQueueResult = 'updated' | 'unchanged' | null;

export interface IngestQueueJob {
  id: string;
  workspace_id: string;
  source_id: string;
  status: IngestQueueStatus;
  phase: IngestQueuePhase;
  result: IngestQueueResult;
  error: string | null;
  touched_pages: string[];
  attempt_count: number;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string | null;
  source_title: string | null;
  source_mime_type: string | null;
  workspace_name?: string;
}

export interface IngestStartResponse {
  jobId: string;
  status: IngestQueueStatus;
  result: IngestQueueResult;
  routed_workspace_id?: string;
  routed_workspace_name?: string;
  routed_workspace_created?: boolean;
}

const statusSet = new Set<string>(INGEST_STATUSES);
const phaseSet = new Set<string>(INGEST_PHASES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : typeof value === 'string' ? value : null;
}

function isValidResult(value: unknown): value is Exclude<IngestQueueResult, null> {
  return value === 'updated' || value === 'unchanged';
}

export function isIngestQueueStatus(value: unknown): value is IngestQueueStatus {
  return typeof value === 'string' && statusSet.has(value);
}

export function isIngestQueuePhase(value: unknown): value is IngestQueuePhase {
  return typeof value === 'string' && phaseSet.has(value);
}

export function isActiveIngestStatus(status: IngestQueueStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'paused';
}

export function parseIngestQueueJob(value: unknown): IngestQueueJob | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : typeof value.jobId === 'string' ? value.jobId : null;
  const workspaceId = typeof value.workspace_id === 'string' ? value.workspace_id : null;
  const sourceId = typeof value.source_id === 'string' ? value.source_id : null;
  const status = isIngestQueueStatus(value.status) ? value.status : null;
  const phase = isIngestQueuePhase(value.phase) ? value.phase : null;
  if (!id || !workspaceId || !sourceId || !status || !phase) return null;
  if (value.touched_pages !== undefined && !Array.isArray(value.touched_pages)) return null;
  if (Array.isArray(value.touched_pages) && !value.touched_pages.every((item) => typeof item === 'string')) return null;
  if (value.attempt_count !== undefined && (typeof value.attempt_count !== 'number' || !Number.isFinite(value.attempt_count))) return null;
  if (value.result !== undefined && value.result !== null && !isValidResult(value.result)) return null;
  return {
    id,
    workspace_id: workspaceId,
    source_id: sourceId,
    status,
    phase,
    result: isValidResult(value.result) ? value.result : null,
    error: optionalString(value.error),
    touched_pages: Array.isArray(value.touched_pages) ? value.touched_pages as string[] : [],
    attempt_count: typeof value.attempt_count === 'number' ? value.attempt_count : 0,
    started_at: optionalString(value.started_at),
    finished_at: optionalString(value.finished_at),
    updated_at: optionalString(value.updated_at),
    source_title: optionalString(value.source_title),
    source_mime_type: optionalString(value.source_mime_type),
  };
}

export function parseIngestJobsResponse(value: unknown, workspaceId: string): IngestQueueJob[] | null {
  if (!isRecord(value) || value.workspace_id !== workspaceId || !Array.isArray(value.jobs)) return null;
  const jobs = value.jobs.map(parseIngestQueueJob);
  return jobs.every((job): job is IngestQueueJob => job !== null) ? jobs : null;
}

export function parseIngestStartResponse(value: unknown): IngestStartResponse | null {
  if (!isRecord(value) || typeof value.jobId !== 'string' || !isIngestQueueStatus(value.status)) return null;
  const result = isValidResult(value.result) ? value.result : null;
  if (value.result !== undefined && value.result !== null && result === null) return null;
  if (value.routed_workspace_id !== undefined && typeof value.routed_workspace_id !== 'string') return null;
  if (value.routed_workspace_name !== undefined && typeof value.routed_workspace_name !== 'string') return null;
  if (value.routed_workspace_created !== undefined && typeof value.routed_workspace_created !== 'boolean') return null;
  return {
    jobId: value.jobId,
    status: value.status,
    result,
    ...(typeof value.routed_workspace_id === 'string' ? { routed_workspace_id: value.routed_workspace_id } : {}),
    ...(typeof value.routed_workspace_name === 'string' ? { routed_workspace_name: value.routed_workspace_name } : {}),
    ...(typeof value.routed_workspace_created === 'boolean'
      ? { routed_workspace_created: value.routed_workspace_created }
      : {}),
  };
}

export function mergeIngestQueueJobs(
  ...groups: readonly (readonly IngestQueueJob[])[]
): IngestQueueJob[] {
  const byId = new Map<string, IngestQueueJob>();
  for (const group of groups) {
    for (const job of group) {
      const previous = byId.get(job.id);
      byId.set(job.id, {
        ...previous,
        ...job,
        source_title: job.source_title ?? previous?.source_title ?? null,
        source_mime_type: job.source_mime_type ?? previous?.source_mime_type ?? null,
        workspace_name: job.workspace_name ?? previous?.workspace_name,
      });
    }
  }
  return [...byId.values()].sort((a, b) => {
    const left = a.updated_at ? Date.parse(a.updated_at) : 0;
    const right = b.updated_at ? Date.parse(b.updated_at) : 0;
    return right - left;
  });
}

export function isSupportedIngestFile(fileName: string, _mimeType: string): boolean {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return ['.txt', '.md', '.pdf', '.docx', '.pptx', '.epub', '.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension);
}

export function ingestFileMimeForUpload(fileName: string, mimeType: string): string {
  const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  const expected: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.epub': 'application/epub+zip',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  const normalized = mimeType.trim().toLowerCase().split(';', 1)[0] ?? '';
  return !normalized || normalized === 'application/octet-stream' || normalized === 'application/zip'
    ? expected[extension] ?? normalized
    : normalized;
}
