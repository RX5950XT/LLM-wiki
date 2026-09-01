export type Uuid = string & { readonly __brand: 'uuid' };
export type Iso8601 = string & { readonly __brand: 'iso8601' };

export type PageZone = 'wiki' | 'notes' | 'schema';

export type PageKind =
  | 'index'
  | 'log'
  | 'entity'
  | 'concept'
  | 'summary'
  | 'synthesis'
  | 'note'
  | 'schema'
  | 'lint';

export type UpdatedBy = 'llm' | 'human';

export type SourceKind = 'url' | 'file' | 'text';

export type IngestStatus = 'pending' | 'running' | 'paused' | 'done' | 'failed';
export type IngestPhase = 'analysis' | 'writing' | 'review' | 'done';
export type IngestResult = 'updated' | 'unchanged';

export type LogKind = 'ingest' | 'query' | 'lint' | 'manual_edit';

export interface Workspace {
  id: Uuid;
  owner_id: Uuid;
  name: string;
  description: string | null;
  drive_folder_id: string;
  default_profile_id: Uuid | null;
  sort_order: number;
  created_at: Iso8601;
}

export interface Page {
  id: Uuid;
  workspace_id: Uuid;
  slug: string;
  kind: PageKind;
  zone: PageZone;
  title: string | null;
  drive_file_id: string;
  content_hash: string | null;
  frontmatter: Record<string, unknown> | null;
  version: number;
  updated_at: Iso8601;
  updated_by: UpdatedBy;
  locked_by_human: boolean;
}

export interface Source {
  id: Uuid;
  workspace_id: Uuid;
  kind: SourceKind;
  title: string | null;
  url: string | null;
  drive_file_id: string | null;
  content_sha256: string | null;
  mime_type: string | null;
  byte_size: number | null;
  metadata: Record<string, unknown> | null;
  created_at: Iso8601;
  ingested_at: Iso8601 | null;
}

export interface PageLink {
  workspace_id: Uuid;
  from_slug: string;
  to_slug: string;
}

export interface LLMProfile {
  id: Uuid;
  owner_id: Uuid;
  name: string;
  base_url: string;
  /** Only API-key-encrypted bytes; never exposed to clients in decrypted form. */
  api_key_encrypted: string;
  model: string;
  extra_headers: Record<string, string>;
  /** AES-256-GCM ciphertext of extra_headers JSON; authoritative when present. */
  extra_headers_encrypted?: string | null;
  is_default: boolean;
  created_at: Iso8601;
}

export interface IngestJob {
  id: Uuid;
  workspace_id: Uuid;
  source_id: Uuid;
  status: IngestStatus;
  phase: IngestPhase;
  touched_pages: string[];
  profile_id: Uuid | null;
  error: string | null;
  started_at: Iso8601 | null;
  finished_at: Iso8601 | null;
  checkpoint: Record<string, unknown>;
  attempt_count: number;
  source_sha256: string | null;
  result: IngestResult | null;
  updated_at: Iso8601;
}

export interface LogEntry {
  id: number;
  workspace_id: Uuid;
  kind: LogKind;
  summary: string;
  payload: Record<string, unknown> | null;
  created_at: Iso8601;
}

export interface IngestPlan {
  people: string[];
  concepts: string[];
  evidence: string[];
  contradictions: Array<{ page: string; note: string }>;
  target_pages: string[];
  summary: string;
}

export interface IngestReview {
  written_pages: string[];
  missing_pages: string[];
  contradictions: Array<{ page: string; note: string }>;
  issues: string[];
  complete: boolean;
  summary: string;
}

export interface IngestCheckpoint {
  plan?: IngestPlan;
  written_pages: string[];
  review?: IngestReview;
}

export interface QueryCitation {
  slug: string;
  excerpt: string;
}

export interface QueryResponse {
  answer_md: string;
  citations: QueryCitation[];
}

export interface ApiEnvelope<T> {
  ok: boolean;
  data: T | null;
  error: string | null;
}
