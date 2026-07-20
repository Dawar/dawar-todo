import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { apiTokenFromAuthorization, hashApiToken } from "../db/api-tokens.ts";
import { appAccessResponse } from "../worker/access.ts";

const root = new URL("../", import.meta.url);

test("accepts valid Bearer tokens and rejects invalid or privileged token requests", async () => {
  const rawToken = `dt_live_${"A".repeat(43)}`;
  const tokenHash = await hashApiToken(rawToken);
  const pending = [];
  const database = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (!sql.includes("SELECT")) return null;
              assert.equal(values[0], tokenHash);
              return {
                id: "11111111-1111-4111-8111-111111111111",
                name: "Agent access",
                token_prefix: "dt_live_AAAAAAAA…",
                created_by_email: "owner@example.com",
                created_at: "2026-07-20T12:00:00.000Z",
                last_used_at: null,
                expires_at: null,
              };
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const context = { waitUntil(promise) { pending.push(promise); } };
  const accepted = await appAccessResponse(new Request("https://work.dawar.ca/api/todos", {
    headers: { Authorization: `Bearer ${rawToken}` },
  }), { DB: database }, context);
  assert.equal(accepted, null);
  await Promise.all(pending);

  const invalid = await appAccessResponse(new Request("https://work.dawar.ca/api/todos", {
    headers: { Authorization: "Bearer dt_live_invalid" },
  }), { DB: database }, context);
  assert.equal(invalid?.status, 401);
  assert.match(invalid?.headers.get("www-authenticate") ?? "", /Bearer/);

  const management = await appAccessResponse(new Request("https://work.dawar.ca/api/api-tokens", {
    headers: { Authorization: `Bearer ${rawToken}` },
  }), { DB: database }, context);
  assert.equal(management?.status, 403);
});

test("ships hashed revocable API tokens and a public agent specification", async () => {
  const [schema, database, tokens, access, settings, tokenRoute, revokeRoute, migration, openApiText] = await Promise.all([
    readFile(new URL("db/schema.ts", root), "utf8"),
    readFile(new URL("db/todos.ts", root), "utf8"),
    readFile(new URL("db/api-tokens.ts", root), "utf8"),
    readFile(new URL("worker/access.ts", root), "utf8"),
    readFile(new URL("app/settings/page.tsx", root), "utf8"),
    readFile(new URL("app/api/api-tokens/route.ts", root), "utf8"),
    readFile(new URL("app/api/api-tokens/[id]/route.ts", root), "utf8"),
    readFile(new URL("drizzle/0008_military_proudstar.sql", root), "utf8"),
    readFile(new URL("public/openapi.json", root), "utf8"),
  ]);
  const openApi = JSON.parse(openApiText);

  assert.match(schema, /todoApiTokens/);
  assert.match(database, /CREATE TABLE IF NOT EXISTS todo_api_tokens/);
  assert.match(migration, /CREATE TABLE `todo_api_tokens`/);
  assert.match(tokens, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(tokens, /dt_live_/);
  assert.doesNotMatch(migration, /`token` text/);
  assert.match(tokens, /revoked_at IS NULL/);
  assert.match(tokens, /expires_at IS NULL OR expires_at >/);
  assert.match(tokens, /last_used_at/);
  assert.match(access, /apiTokenFromAuthorization/);
  assert.match(access, /WWW-Authenticate/);
  assert.match(access, /\/api\/api-tokens/);
  assert.match(access, /pathname === "\/openapi\.json"/);
  assert.match(settings, /API access/);
  assert.match(settings, /Generate token/);
  assert.match(settings, /Copy OpenAPI URL/);
  assert.match(settings, /shown only once/);
  assert.match(tokenRoute, /Cache-Control/);
  assert.match(tokenRoute, /createdByEmail: email/);
  assert.match(revokeRoute, /revokeApiToken/);

  assert.equal(openApi.openapi, "3.1.0");
  assert.deepEqual(openApi.security, [{ bearerAuth: [] }]);
  assert.equal(openApi.components.securitySchemes.bearerAuth.scheme, "bearer");
  assert.ok(openApi.paths["/api/todos"]);
  assert.ok(openApi.paths["/api/todos/bulk"]);
  assert.ok(openApi.paths["/api/projects"]);
  assert.ok(openApi.paths["/api/todos/{id}/attachments"]);
  assert.equal(openApi.paths["/api/api-tokens"], undefined);
});

test("parses only Bearer authorization values and hashes deterministically", async () => {
  const token = `dt_live_${"B".repeat(43)}`;
  assert.equal(apiTokenFromAuthorization(`Bearer ${token}`), token);
  assert.equal(apiTokenFromAuthorization(`bearer   ${token}`), token);
  assert.equal(apiTokenFromAuthorization(`Basic ${token}`), null);
  assert.equal(apiTokenFromAuthorization(null), null);
  assert.equal(await hashApiToken(token), await hashApiToken(token));
  assert.notEqual(await hashApiToken(token), await hashApiToken(`${token}x`));
});
