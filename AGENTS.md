# AGENTS.md

@README.md has what this plugin does and how end users configure it.
@CONTRIBUTING.md has full dev setup, the commit convention, and the release process — read it before committing or touching CI.

## Layout

- `src/index.ts` — plugin entrypoint, registers tools with OpenClaw
- `src/tools/` — one file per tool group (documents, taxonomy, relations, pagination)
- `src/client.ts` — typed paperless-ngx API client
- `src/generated/paperless-schema.d.ts` — generated, do not hand-edit (see CONTRIBUTING.md)
- `skills/` — OpenClaw agent skills bundled with the plugin
- `*.test.ts` — colocated with the source they test

## Working in this repo

- Run `pnpm run build`, `pnpm run lint`, `pnpm run test` before committing.
- Commit messages **must** follow Conventional Commits — semantic-release derives the npm version
  and GitHub release from them on every push to `main`. A non-conventional message just won't ship.
- Never hand-edit `version` in `package.json` — semantic-release owns it.
- A brand-new package's first npm publish is a manual, one-time bootstrap step (see
  CONTRIBUTING.md) — don't try to "fix" a failing first release by adding more workflow logic.
