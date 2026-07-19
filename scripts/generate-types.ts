/**
 * Regenerates src/generated/paperless-schema.d.ts from a live paperless-ngx
 * instance's OpenAPI schema. Requires PAPERLESS_URL and PAPERLESS_TOKEN in
 * the environment (or a .env file loaded by the caller).
 *
 * The schema is fetched with `curl` rather than `fetch()`: on macOS, Local
 * Network access (TCC) is enforced per-binary via Info.plist entitlements,
 * and bare `node`/`python3` get silently blocked (EHOSTUNREACH) hitting LAN
 * IPs while `curl` is exempt.
 *
 * openapi-typescript's codegen only supports typescript ^5.x, so it's run
 * via `pnpm dlx` in an isolated resolution rather than the project's own
 * TypeScript devDependency (kept at the latest major for the plugin build).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseUrl = process.env.PAPERLESS_URL;
const token = process.env.PAPERLESS_TOKEN;

if (!baseUrl || !token) {
  console.error("PAPERLESS_URL and PAPERLESS_TOKEN must be set to regenerate types.");
  process.exit(1);
}

const schemaUrl = new URL("/api/schema/", baseUrl).toString();

const tmpDir = mkdtempSync(join(tmpdir(), "paperless-schema-"));
const schemaPath = join(tmpDir, "schema.json");

const curlResult = spawnSync(
  "curl",
  [
    "-fsS",
    "-H",
    `Authorization: Token ${token}`,
    "-H",
    "Accept: application/json",
    schemaUrl,
    "-o",
    schemaPath,
  ],
  { stdio: "inherit" },
);

if (curlResult.status !== 0) {
  rmSync(tmpDir, { recursive: true, force: true });
  console.error(`Failed to fetch schema from ${schemaUrl}`);
  process.exit(curlResult.status ?? 1);
}

const outPath = "src/generated/paperless-schema.d.ts";
const result = spawnSync("pnpm", ["dlx", "openapi-typescript", schemaPath, "-o", outPath], {
  stdio: "inherit",
});

rmSync(tmpDir, { recursive: true, force: true });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Wrote ${outPath}`);
