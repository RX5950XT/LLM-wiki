# LLM Wiki

> A persistent, compounding knowledge base that LLMs maintain for you — across Web and Android, synced through your own Google Drive.

Based on the pattern from Andrej Karpathy, Lex Fridman, and tobi — where the LLM reads your sources, integrates them into an interlinked markdown wiki, and keeps the whole thing current so you don't have to.

## Why this exists

Most "chat with your documents" tools retrieve fragments on every query and forget everything between sessions. LLM Wiki is different: the LLM incrementally **compiles** every new source into a structured wiki (summaries, entity pages, cross-references, contradictions flagged). The wiki is the persistent artifact. You own the data — it lives in your own Google Drive as plain markdown, openable in Obsidian, VS Code, or anything that reads text files.

## Core principles

1. **Ingest is compilation, not indexing** — one source touches 10+ existing pages
2. **Query answers file back into the wiki** — your exploration compounds
3. **LLM owns the wiki layer; humans direct** — you curate sources and ask questions
4. **Raw sources are immutable** — full traceability
5. **User notes and AI wiki are physically separated** (Steph Ango's principle)
6. **Schema co-evolves** — you tune the prompts that guide the LLM
7. **Conversation + live wiki is the UX** — chat on one side, wiki updating on the other

## Tech stack

- **Web** — Next.js 16 App Router + Tailwind v4 + shadcn/ui, deployed on Vercel
- **Android** — Kotlin + Jetpack Compose
- **Metadata** — Supabase (Postgres + Auth + Realtime)
- **Storage** — Your own Google Drive (we store nothing except metadata)
- **LLM** — BYO key with OpenAI-compatible endpoints (OpenRouter / OpenAI / Anthropic / Ollama / any)

## Status

🚧 Under active development. See `plans/` for the architecture plan.

## License

MIT
