# Contributing

## Dev setup

```bash
pnpm install
pnpm run build
pnpm run lint
pnpm run test
```

Node version is pinned in `.nvmrc`.

`node-llama-cpp` (the semantic-search embedding runtime; see `src/semantic/embedding-provider.ts`)
runs a `postinstall` step that fetches a prebuilt native binary for your platform (falling back to a
local `cmake` build only if no prebuilt is available). pnpm blocks dependency build scripts by
default; this repo's `pnpm-workspace.yaml` pre-approves it via `allowBuilds`, so a plain `pnpm install`
is enough -- no extra flags needed.

### Regenerating API types

`src/generated/paperless-schema.d.ts` is generated from your paperless-ngx instance's live OpenAPI
schema via [openapi-typescript](https://openapi-ts.dev/):

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

## Commit messages

This repo releases via [semantic-release](https://semantic-release.gitbook.io/semantic-release/):
every commit message on `main` must follow [Conventional Commits](https://www.conventionalcommits.org/),
because the release automation reads the commit history to decide what to publish. There is no
manual version bump anymore — don't edit `version` in `package.json`.

| Prefix | Effect |
| --- | --- |
| `fix: ...` | patch release |
| `feat: ...` | minor release |
| `feat!: ...` or a `BREAKING CHANGE:` footer | major release |
| `chore:`, `docs:`, `refactor:`, `test:`, `ci:` | no release |

## Release process

Merging to `main` runs `.github/workflows/release.yml`, which runs `semantic-release`: it computes
the next version from commits since the last release, publishes to npm (via trusted OIDC
publishing — no token secret), tags the commit, and creates a GitHub release with generated notes.

Publishing to ClawHub is still a separate manual step:
`clawhub package publish transmitt0r/openclaw-plugin-paperless-ngx` — CI automation for this hit an
environment-specific bug in ClawHub's npm-pack invocation that hasn't been root-caused yet.

### Bootstrapping a brand-new package

npm trusted publishing can only be configured for a package that already exists on the registry, so
a package's very first release needs one manual `npm publish` from a maintainer's machine, then a
trusted publisher (this repo + `release.yml`) added under the package's Settings → Trusted
publishing on npmjs.com. Every release after that is fully automatic.
