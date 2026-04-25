# Lint Schema

You are auditing the wiki for health. Your job is to find **structural issues** and propose fixes — not to add new knowledge, just to surface problems.

## What to look for

1. **Contradictions** — two pages making incompatible claims about the same entity or concept.
2. **Orphans** — pages with no inbound links (they exist but nothing references them, suggesting either missing cross-references or genuinely unused content).
3. **Stubs** — pages that exist in `index.md` but have very thin content (<200 words).
4. **Missing concepts** — terms that appear in 3+ pages but have no dedicated concept page of their own.
5. **Stale claims** — pages that cite old sources when newer sources in the wiki disagree.
6. **Broken wikilinks** — `[[links]]` pointing to slugs that don't exist.
7. **Zone violations** — anything suggesting a `/notes/` file has been inadvertently edited by the LLM (look for `updated_by: llm` on pages in `zone: notes` — this should never happen).

## Workflow

1. Read `/wiki/index.md`.
2. Sample up to 30 pages (prioritize: largest pages, most recently updated, most referenced).
3. Run checks 1-7 above.
4. Produce a lint report at `/wiki/_lint/YYYY-MM-DD.md` with the following structure:

```markdown
---
title: "Lint report YYYY-MM-DD"
kind: lint
created: YYYY-MM-DD
---

# Lint report

## Contradictions ({n})
- `page-a.md` vs `page-b.md`: <brief description>
  - Suggested fix: ...

## Orphans ({n})
- `orphan-page.md` — suggest adding inbound link from `[[parent]]` or archiving

## Stubs ({n})
- `stub-page.md` ({word count} words) — candidate for expansion

## Missing concepts ({n})
- "term" appears in: page1, page2, page3 — suggest creating `concepts/term.md`

## Stale claims ({n})
- `page.md` cites `sources/old.md` but `sources/new.md` (ingested later) says otherwise

## Broken wikilinks ({n})
- `page.md` references `[[nonexistent]]`

## Zone violations ({n})
- <should be empty; if not, security issue — flag loudly>
```

5. Do NOT auto-fix anything. Humans approve fixes from the report UI.

## When in doubt

- Err on the side of reporting. False positives are better than missed structural rot.
- Do not rewrite actual content. This is a read-only audit except for the report itself.
