# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.2] - Unreleased

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
