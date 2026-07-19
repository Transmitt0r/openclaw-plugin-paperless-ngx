# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/).

## [0.2.0] - Unreleased

- **Breaking:** remove `paperless_list_documents`' `is_in_inbox` filter.
  It was really just a special case of `tag_id` scoped to whichever tag
  happens to be the inbox tag, which baked one specific workflow's concept
  into an otherwise generic, API-mirroring tool. Resolve the inbox tag's
  id via `paperless_list_tags` (`is_inbox_tag: true`) and pass it as
  `tag_id` instead -- the bundled paperless-ingest skill already does
  this in its pre-flight step.
- Bundle two example skills (`skills/paperless-search`,
  `skills/paperless-ingest`) via the manifest's `skills` field, so they
  install automatically alongside the plugin instead of needing manual
  deployment into an OpenClaw workspace.

## [0.1.3] - 2026-07-20

- Actually resolve `apiToken` when it's a SecretRef. 0.1.2 accepted a
  SecretRef at config-validation time (fixing `apiToken: must be string`)
  but never resolved it -- `api.pluginConfig.apiToken` arrives as the raw
  `{source, provider, id}` object, not a string, since OpenClaw does not
  pre-resolve plugin config despite the field being marked sensitive. That
  object got template-stringified into the Authorization header
  (`Token [object Object]`), which paperless-ngx rejected as "Token string
  should not contain spaces" -- a genuinely confusing failure mode to
  debug from the error message alone. `register()` is now async and calls
  `resolveSecretRefValues` from `openclaw/plugin-sdk/secret-ref-runtime`
  explicitly before constructing the HTTP client.

## [0.1.2] - 2026-07-20

- `apiToken` config now accepts a SecretRef object as well as a plain
  string (matches how other secret-capable bundled plugins, e.g. brave's
  `webSearch.apiKey`, type their sensitive fields). Previously `config set
  --ref-provider ...` was rejected at validation (`apiToken: must be
  string`), which meant the only way to configure it was a plaintext
  string sitting directly in `openclaw.json`.

## [0.1.1] - 2026-07-19

- Fix `package.json`'s `openclaw.extensions` field: OpenClaw requires an
  array, not a bare string. The published 0.1.0 has this bug and fails to
  load (`package.json openclaw.extensions must be an array`) -- found by
  actually installing the plugin with a real OpenClaw CLI instead of just
  building/testing in isolation.

## [0.1.0] - 2026-07-19

Initial release. Tools for listing/searching/getting/updating paperless-ngx
documents, and listing/creating tags, correspondents, and document types.
