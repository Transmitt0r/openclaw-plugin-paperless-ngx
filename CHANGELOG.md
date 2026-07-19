# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/).

## [0.1.1] - Unreleased

- Fix `package.json`'s `openclaw.extensions` field: OpenClaw requires an
  array, not a bare string. The published 0.1.0 has this bug and fails to
  load (`package.json openclaw.extensions must be an array`) -- found by
  actually installing the plugin with a real OpenClaw CLI instead of just
  building/testing in isolation.

## [0.1.0] - 2026-07-19

Initial release. Tools for listing/searching/getting/updating paperless-ngx
documents, and listing/creating tags, correspondents, and document types.
