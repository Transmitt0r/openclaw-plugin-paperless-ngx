# openclaw-plugin-paperless-ngx

[![CI](https://github.com/Transmitt0r/openclaw-plugin-paperless-ngx/actions/workflows/ci.yml/badge.svg)](https://github.com/Transmitt0r/openclaw-plugin-paperless-ngx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An [OpenClaw](https://docs.openclaw.ai) plugin for [paperless-ngx](https://docs.paperless-ngx.com/).

It registers a handful of generic agent tools over the paperless-ngx REST API — list/search
documents, get a document, patch a document, and list/create tags, correspondents, and document
types. The tools mirror the API rather than any particular workflow, so they're equally useful for
ad-hoc lookups or for an agent doing multi-step triage (e.g. clearing an inbox).

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
| `paperless_list_documents` | Search/filter documents (full-text search, correspondent, document type, tag, date range, ordering, pagination), or batch-fetch by `ids`. Results include OCR content and a link to each document in the paperless-ngx web UI. |
| `paperless_get_document` | Fetch a single document by id. |
| `paperless_update_document` | Patch a document's title, correspondent, document type, tags, or created date. Never touches `storage_path`. |
| `paperless_list_tags` | List tags, optionally filtered by name. |
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

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run lint
```

### Regenerating API types

`src/generated/paperless-schema.d.ts` is generated from your paperless-ngx instance's live OpenAPI
schema via [openapi-typescript](https://openapi-ts.dev/), and consumed through
[openapi-fetch](https://openapi-ts.dev/openapi-fetch/) for a fully typed client:

```bash
export PAPERLESS_URL=https://paperless.example.com
export PAPERLESS_TOKEN=your-api-token
pnpm run generate:types
```

Re-run this after upgrading paperless-ngx if you rely on newer filters or fields.

Note: `openapi-typescript`'s codegen currently only supports TypeScript ^5.x, while this project
builds against the latest TypeScript major. `generate:types` runs the generator through `pnpm dlx`
in an isolated resolution so it gets a compatible TypeScript without downgrading the project's own
devDependency.
