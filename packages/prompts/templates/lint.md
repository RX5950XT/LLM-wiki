# Health Check Schema

When the user presses "Tidy knowledge base", the AI walks every workspace with this checklist and **fixes what it finds** directly.

## Check and fix

1. **Broken wikilinks** — `[[link]]` pointing at a page that does not exist → repair the slug or drop the link.
2. **Duplicated knowledge** — the same entity/concept spread over several pages or workspaces → merge into the best page, delete the redundant ones.
3. **Contradictions** — two pages disagreeing about the same thing → reconcile into one correct statement.
4. **Orphans** — pages with no inbound link → link them from a related page or `index.md`.
5. **Stubs** — very thin pages → merge them into a better home, or flesh them out.
6. **Misplaced pages** — a page that clearly belongs to another workspace → move it there.
7. **Index & log** — keep `index.md` accurate and append one `log.md` entry describing this run.

## Rules

- Fix things with tools. **Never write a report page** (no `_lint/`, no `_organize/`).
- Never modify pages with `locked_by_human: true`.
- Write only under `wiki/`; `notes/`, `_schema/` and `sources/` are off limits.
- Prefer fewer, higher-quality pages over many fragments.
