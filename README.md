# openclaw-plugin-paperless-ngx

[![CI](https://github.com/Transmitt0r/openclaw-plugin-paperless-ngx/actions/workflows/ci.yml/badge.svg)](https://github.com/Transmitt0r/openclaw-plugin-paperless-ngx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An [OpenClaw](https://docs.openclaw.ai) plugin for [paperless-ngx](https://docs.paperless-ngx.com/).

It registers a handful of generic agent tools over the paperless-ngx REST API — list/search
documents, get a document (or a bounded excerpt of one via pattern search or a line range), patch
a document, and list/create tags, correspondents, and document types. The tools mirror the API
rather than any particular workflow, so they're equally useful for ad-hoc lookups or for an agent
doing multi-step triage (e.g. clearing an inbox).

## Install

```bash
openclaw plugins install clawhub:transmitt0r/openclaw-plugin-paperless-ngx
```

Or for local development, point OpenClaw at a built copy of this repo.

## Configure

The plugin needs the base URL of your paperless-ngx instance and an API token
(Settings → My Profile → API Token in paperless-ngx):

```json
{
  "plugins": {
    "entries": {
      "paperless-ngx": {
        "config": {
          "baseUrl": "https://paperless.example.com",
          "apiToken": "your-api-token"
        }
      }
    }
  }
}
```

`apiToken` also accepts a [SecretRef](https://docs.openclaw.ai/cli/config) instead of a plain string, so it doesn't have to sit in `openclaw.json` in cleartext:

```bash
openclaw config set plugins.entries.paperless-ngx.config.apiToken \
  --ref-provider default --ref-source env --ref-id PAPERLESS_TOKEN
```

(or `--ref-source exec`/`file` for a password manager CLI, vault, etc.)

## Tools

| Tool | Description |
| --- | --- |
| `paperless_list_documents` | Search/filter documents (full-text search, correspondent, document type, tag, date range, ordering, pagination), or batch-fetch by `ids`. Never returns OCR content — a `content_snippet` around the match is included instead when `search`/`query` is set. Also includes a link to each document in the paperless-ngx web UI and correspondent/document type/tag names resolved alongside their ids. |
| `paperless_get_document` | Fetch a single document by id. Same automatic name resolution as `paperless_list_documents`. `include_content: true` returns OCR content capped at 500 lines (omitted by default) — prefer `paperless_grep_document`/`paperless_get_document_range` when you're after a specific detail rather than the whole document. |
| `paperless_grep_document` | Search one document's OCR content for a pattern (like `grep -n -C`) without pulling the whole document into context — returns matching lines plus surrounding context. |
| `paperless_get_document_range` | Fetch a specific line range (capped at 500 lines/call) of a document's OCR content; page through a long document by following up with `start_line` past what you've already read. |
| `paperless_update_document` | Patch a document's title, correspondent, document type, tags, or created date. Use `tags` for a full replacement, or `add_tag_ids`/`remove_tag_ids` to adjust tags without disturbing the rest. Never touches `storage_path`. OCR `content` is omitted from the response unless `fields` explicitly includes `"content"` (capped at 500 lines, same as `paperless_get_document`). |
| `paperless_list_tags` | List tags, optionally filtered by name. Resolves parent/children tag ids to names. |
| `paperless_create_tag` | Create a new tag. |
| `paperless_list_correspondents` | List correspondents, optionally filtered by name. |
| `paperless_create_correspondent` | Create a new correspondent. |
| `paperless_list_document_types` | List document types, optionally filtered by name. |
| `paperless_create_document_type` | Create a new document type. |

There's deliberately no delete tool in this first pass.

## Skills

The plugin also bundles two example skills (`skills/`) that OpenClaw picks up automatically once
it's installed:

- **paperless-search** — on-demand document search ("find my car insurance policy")
- **paperless-ingest** — inbox triage: read OCR, assign correspondent/type/tags/title/date, remove
  the inbox tag. Can run on a schedule (e.g. heartbeat) or on demand.

These are starting points, not fixed behavior — the title convention, legal-suffix list, safety
rules, etc. are all easy to adapt; copy `skills/paperless-ingest/SKILL.md` into your own workspace
and edit it if the defaults don't fit.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, regenerating API types, commit conventions,
and how releases work.
