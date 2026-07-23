---
name: "paperless-search"
description: "Search the user's paperless-ngx documents by full-text OCR query. On-demand: find insurance, receipts, tax docs by year, etc."
---

# Paperless Search

Search the user's paperless-ngx documents by full-text OCR query, using the paperless-ngx plugin's tools (`paperless_search_documents`, `paperless_get_document`, `paperless_search_document_content`, `paperless_read_document`, `paperless_list_taxonomy`). `paperless_search_documents` never returns OCR content at all — lean on its `content_snippet`s. `paperless_get_document` never returns raw content either; pass `excerpt_search` for a short snippet around one term, scoped to a document you already have the id for.

## Triggers

The user asks: "find my car insurance policy", "do I have a receipt for that Ikea order", "what tax documents do I have from last year", or similar search/discovery questions about their document archive.

## Procedure

1. Start broad: `paperless_search_documents` with `search` (full-text, matches OCR content) for the core concept. Don't pre-filter before trying this — full-text alone is usually enough. It never returns full content; when `search`/`query` is set, each result instead gets a short `content_snippet` around the match — usually enough to judge relevance.
2. Add filters only from constraints the user actually gave:
   - A correspondent name → resolve to an id via `paperless_list_taxonomy(kind: "correspondent")` first, don't guess the id, then pass `correspondent_id`
   - A date → `created_from`/`created_to` (`YYYY-MM-DD`)
   - A tag → resolve to an id via `paperless_list_taxonomy(kind: "tag")` first, then pass `tag_id` (single tag filter)
3. Zero results → broaden before giving up: fewer/different query terms (try synonyms, other likely languages, partial words), drop filters one at a time.
4. Present results compactly — title, correspondent, date, doc id, `content_snippet`.
5. Once you already know a candidate's document id (from step 1 or 4) and just need one specific detail from it — an amount, a policy number, a clause, a date — do NOT call `paperless_read_document` to read the whole thing. Use `paperless_search_document_content` instead: pattern-match the term you're actually looking for (e.g. for a total, try `pattern: "Gesamtbetrag|Betrag|Summe|Total"`). `paperless_get_document`'s `excerpt_search` works too for a single simple term. Reach for `paperless_read_document` only when you genuinely need to read a section of the document, not just extract one fact — it is not a shortcut for "I already know which document, now let me look inside it."
6. Multiple plausible matches → list them for the user to pick, don't guess which one they meant.

## Safety rules

- Never modify anything on the paperless side from this skill — that's the user's call, via `paperless_update_document` on request.
- Never guess a document match when multiple are plausible — present options.
- Present what was found honestly — don't fabricate or assume document existence.
