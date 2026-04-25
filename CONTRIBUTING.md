# Contributing to LLM Wiki

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Development Setup

### Prerequisites

- Node.js 22 or Bun 1.x
- A Supabase project (free tier)
- A Google Cloud project with OAuth 2.0 credentials and the Drive API enabled
- (Optional) An OpenRouter / OpenAI API key for testing the LLM pipelines

### First-time setup

```bash
git clone https://github.com/your-org/llm-wiki
cd llm-wiki
bun install
cp apps/web/.env.example apps/web/.env.local
# Fill in the required environment variables (see below)
bun run dev
```

### Environment variables

See `apps/web/.env.example` for the full list. The minimum set to run the web app:

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-only) |
| `ENCRYPTION_KEY` | 32-byte hex string — encrypt API keys at rest |
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth client secret |
| `CRON_SECRET` | Random secret used to authenticate the lint cron endpoint |

### Database migrations

```bash
# Apply the initial schema to your Supabase project
supabase db push --db-url "$DATABASE_URL"
# or manually run supabase/migrations/0001_init.sql in the Supabase dashboard
```

## Project structure

```
llm-wiki/
├── apps/
│   ├── web/        Next.js 16 App Router (main web app)
│   └── android/    Kotlin + Jetpack Compose
└── packages/
    ├── shared-types/   TypeScript types used by web
    ├── prompts/        LLM system prompt templates (ingest, query, lint)
    └── drive-schema/   Google Drive folder path constants
```

## Development workflow

### Running the web app

```bash
bun run dev          # start dev server at http://localhost:3000
bun run typecheck    # TypeScript check (all packages)
bun run build        # production build
```

### Working on LLM prompts

The ingest, query, and lint prompts live in `packages/prompts/templates/`. Editing them changes the default behaviour for all new workspaces.

Users can override prompts per-workspace by editing `_schema/ingest.md` etc. in their Google Drive folder.

### Running the Android app

1. Open `apps/android/` in Android Studio Hedgehog or newer.
2. Create `apps/android/local.properties`:
   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_ANON_KEY=eyJ...
   GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   ```
3. Run on an emulator or device (API 26+).

## Pull request guidelines

- Keep PRs focused — one concern per PR.
- Run `bun run typecheck` before opening a PR.
- For prompt changes (`packages/prompts/`), describe what behaviour changed and why it better reflects the Karpathy principles.
- For schema changes (`supabase/migrations/`), include a rollback strategy in the PR description.

## Core design principles

All design decisions should be evaluated against the seven Karpathy principles documented in `CLAUDE.md`. The short version:

1. **Ingest = compilation, not indexing** — one source touches ≥10 existing pages
2. **Queries file back** — answers become permanent wiki pages
3. **LLM owns the wiki layer** — humans only direct
4. **Sources are immutable** — full traceability
5. **Separation principle** — `wiki/` and `notes/` are physically separate
6. **Schema co-evolves** — prompt templates are user-tunable
7. **Conversation + live wiki** — the split-panel UX is the product

## Reporting issues

Please use GitHub Issues. Include:
- Steps to reproduce
- Expected vs. actual behaviour
- Browser / Android version
- Whether the issue is in the web app, Android, or a specific API route

## License

MIT — see [LICENSE](LICENSE).
