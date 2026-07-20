---
name: "paperless-ingest"
description: "Triage the paperless-ngx inbox — read OCR, assign correspondent/type/tags/title/date, remove the inbox tag. Can run on a schedule (e.g. heartbeat) or on demand."
---

# Paperless-ngx Inbox Ingest Pipeline

Auto-applies changes, no per-document confirmation. Reports a summary at the end.

Use the paperless-ngx plugin's tools for everything — never make raw HTTP calls.

## Pre-flight (every run)

1. `paperless_list_tags` (page_size=100) — find the inbox tag(s): look for `is_inbox_tag: true` on tag objects. Fallback: a tag literally named "inbox".
2. `paperless_list_document_types` (page_size=100)
3. `paperless_list_correspondents` (page_size=100)

## Fetch inbox docs

`paperless_list_documents` with `tag_id=<inbox tag id from pre-flight>`. Results already include each document's OCR `content` inline — no separate per-document fetch needed.
- Cap at 10 docs/run to keep response time reasonable
- If 0 inbox docs → report "Inbox clear" and stop

## Per document, decide

**Correspondent**: best semantic match against the existing list. Strip common legal-entity suffixes (Inc., LLC, Ltd., GmbH, AG, e.V., Co. KG, S.A., etc.) before comparing. Brand name vs. legal entity name. No match → create one with `paperless_create_correspondent` (`name` required). Never create a near-duplicate of an existing one.

**Document type**: best fit from existing types only. When no existing type is a genuine fit, leave unset and flag it. Never create a new type.

**Tags**: existing non-inbox tags only, by topic. No fit → no tag + flag. Never create a new tag.

**Title**: a sensible default is `YYYY-MM_ShortDescription` — year-month from the document's actual date, then a short content-derived summary — but adapt to whatever convention the user actually wants. Never keep scanner filenames or raw invoice/order/ticket numbers as descriptions. Never include the correspondent name in the title if it's redundant with the `correspondent_id` field. For collisions, escalate the date to the full `YYYY-MM-DD`; if that still collides, append " (2)", " (3)", etc.

**Created date**: the document's actual date from its content, if that's more accurate than what's already set. Format `YYYY-MM-DD`.

## Apply

`paperless_update_document` per document:
- `id`, `title`, `correspondent_id` (id, or `null` to clear), `document_type_id` (id, or `null` to clear), `created` (`YYYY-MM-DD`)
- `add_tag_ids`: any new topic tags to add
- `remove_tag_ids`: the inbox tag id(s) from pre-flight
- All in one call — `add_tag_ids`/`remove_tag_ids` adjust the tag list without needing to know or replay the document's full existing tags.

## Report

Markdown table: id, title, correspondent, type, tags, created, flags.
- Flags: new correspondent created / no document type / no tag / uncertain date
- Note the remaining backlog count if capped

## Safety rules

- Only touch documents currently carrying the inbox tag
- Never delete documents (there's no delete tool)
- Never create tags or document types — flag instead
- Auto-create correspondents only after confirming no close existing match
- Never set `storage_path` on a document (not exposed by `paperless_update_document`)
