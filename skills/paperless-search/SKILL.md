---
name: "paperless-search"
description: "Search the user's paperless-ngx documents by full-text OCR query. On-demand: find insurance, receipts, tax docs by year, etc."
---

# Paperless Search

Search the user's paperless-ngx documents by full-text OCR query, using the paperless-ngx plugin's tools (`paperless_list_documents`, `paperless_get_document`, `paperless_list_correspondents`, `paperless_list_tags`, `paperless_list_document_types`).

## Triggers

The user asks: "find my car insurance policy", "do I have a receipt for that Ikea order", "what tax documents do I have from last year", or similar search/discovery questions about their document archive.

## Procedure

1. Start broad: `paperless_list_documents` with `search` (full-text, matches OCR content) for the core concept. Don't pre-filter before trying this — full-text alone is usually enough. Results already include each document's OCR `content` field, so a follow-up `paperless_get_document` is rarely needed.
2. Add filters only from constraints the user actually gave:
   - A correspondent name → resolve to an id via `paperless_list_correspondents` first, don't guess the id, then pass `correspondent_id`
   - A date → `created_from`/`created_to` (`YYYY-MM-DD`)
   - A tag → resolve to an id via `paperless_list_tags` first, then pass `tag_id` (single tag filter)
3. Zero results → broaden before giving up: fewer/different query terms (try synonyms, other likely languages, partial words), drop filters one at a time.
4. Present results compactly — title, correspondent, date, doc id. Pass `fields` to omit `content` when you only need metadata for a list of candidates; only fetch full content for a specific candidate you need to confirm.
5. Multiple plausible matches → list them for the user to pick, don't guess which one they meant.

## Safety rules

- Never modify anything on the paperless side from this skill — that's paperless-ingest's job.
- Never guess a document match when multiple are plausible — present options.
- Present what was found honestly — don't fabricate or assume document existence.
