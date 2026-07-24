# openclaw-plugin-paperless-ngx

[![CI](https://github.com/Transmitt0r/openclaw-plugin-paperless-ngx/actions/workflows/ci.yml/badge.svg)](https://github.com/Transmitt0r/openclaw-plugin-paperless-ngx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An [OpenClaw](https://docs.openclaw.ai) plugin for [paperless-ngx](https://docs.paperless-ngx.com/).

It registers a small, general-purpose set of agent tools over the paperless-ngx REST API, with a
deliberate focus on retrieval: search documents, get a document's metadata, read a document's
content (bounded, page-able), pattern-search within a document, patch a document, and list/create
tags, correspondents, and document types. Tools are split by *access pattern* (search vs. read vs.
pattern-search), not by resource type, and are bounded by default rather than pulling a document's
full OCR text into context unless a caller specifically reads it that way.

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
| `paperless_search_documents` | Search/filter documents (full-text search, correspondent, document type, tag, date range, ordering, pagination), or batch-fetch by `ids`. Never returns OCR content — a `content_snippet` around the match is included instead when `search`/`query` is set. Also includes a link to each document in the paperless-ngx web UI and correspondent/document type/tag names resolved alongside their ids. `search` is hybrid lexical+semantic under the hood (see below) — no separate param or tool for it. |
| `paperless_get_document` | Fetch a single document's metadata by id. Same automatic name resolution as `paperless_search_documents`. Never returns raw content; pass `excerpt_search` for a short `content_snippet`-style excerpt around one term. |
| `paperless_read_document` | Read a document's OCR content, bounded to a line range (capped at 500 lines/call, defaults to the first 200 if no range is given). Page through a longer document by following up with `start_line` past what you've already read (`total_lines` in the response tells you when there's more). |
| `paperless_search_document_content` | Search one document's OCR content for a pattern (like `grep -n -C`) without reading the whole document into context — returns matching lines plus surrounding context. |
| `paperless_update_document` | Patch a document's title, correspondent, document type, tags, or created date. Use `tags` for a full replacement, or `add_tag_ids`/`remove_tag_ids` to adjust tags without disturbing the rest. Never touches `storage_path`. OCR `content` is omitted from the response unless `fields` explicitly includes `"content"` (capped at 500 lines, same as `paperless_read_document`). |
| `paperless_list_taxonomy` | List tags, correspondents, or document types (`kind: "tag" \| "correspondent" \| "document_type"`), optionally filtered by name. Tags additionally resolve parent/children ids to names. |
| `paperless_create_taxonomy_term` | Create a new tag, correspondent, or document type (`kind`). `parent_id` is only meaningful for `kind: "tag"`. |

There's deliberately no delete tool in this first pass.

### Semantic search

`paperless_search_documents` understands meaning, not just keywords — searching "car insurance"
also finds a document whose text only ever says "Kfz-Haftpflichtversicherung". This happens
automatically inside the existing `search` param; there's no separate tool or mode to choose. It's
fully self-contained: this plugin bundles its own small local embedding model and runs it directly
(no external service, no OCR text leaving your machine, and no other plugin or host config to
install/touch to make it work). Because of that, installing this plugin pulls in a native module
with a larger, platform-specific install step (it fetches a prebuilt binary for your machine; there's
no compiler requirement in the common case). The index builds up in the background after install and
fails open to today's keyword-only behavior if the embedding model can't start for any reason.

It's on by default. To turn it off or move where its local index file lives:

```json
{
  "plugins": {
    "entries": {
      "paperless-ngx": {
        "config": {
          "semanticSearch": {
            "enabled": false,
            "indexPath": "/custom/path/semantic-index.db"
          }
        }
      }
    }
  }
}
```

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
