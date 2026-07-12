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

export type IngestStatus = 'pending' | 'running' | 'done' | 'failed';

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
  touched_pages: string[];
  profile_id: Uuid | null;
  error: string | null;
  started_at: Iso8601 | null;
  finished_at: Iso8601 | null;
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
  new_pages: string[];
  updated_pages: string[];
  contradictions: Array<{ page: string; note: string }>;
  summary: string;
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
