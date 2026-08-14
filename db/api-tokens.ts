const API_TOKEN_PATTERN = /^dt_live_[A-Za-z0-9_-]{43}$/;
const API_TOKEN_LIMIT = 12;
const ALLOWED_EXPIRATION_DAYS = new Set([30, 90, 365]);

type ApiTokenRow = {
  id: string;
  name: string;
  token_prefix: string;
  created_by_email: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
};

export type ApiToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
};

export type ApiTokenIdentity = Pick<ApiToken, "id" | "name" | "tokenPrefix"> & {
  createdByEmail: string;
};

function mapApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  };
}

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function hashApiToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function apiTokenFromAuthorization(header: string | null) {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function authenticateApiToken(db: D1Database, token: string): Promise<ApiTokenIdentity | null> {
  if (!API_TOKEN_PATTERN.test(token)) return null;
  const tokenHash = await hashApiToken(token);
  const row = await db.prepare(`
    SELECT id, name, token_prefix, created_by_email, created_at, last_used_at, expires_at
    FROM todo_api_tokens
    WHERE token_hash = ?
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).bind(tokenHash).first<ApiTokenRow>();
  return row?.created_by_email ? {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    createdByEmail: row.created_by_email.trim().toLowerCase(),
  } : null;
}

export async function recordApiTokenUse(db: D1Database, id: string) {
  try {
    await db.prepare(`
      UPDATE todo_api_tokens
      SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND revoked_at IS NULL
    `).bind(id).run();
    console.info("[todo-auth] API token use recorded", { tokenId: id });
  } catch (error) {
    console.error("[todo-auth] API token last-used update failed", { tokenId: id, error });
  }
}

export async function listApiTokens(db: D1Database): Promise<ApiToken[]> {
  const result = await db.prepare(`
    SELECT id, name, token_prefix, created_by_email, created_at, last_used_at, expires_at
    FROM todo_api_tokens
    WHERE revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ORDER BY created_at DESC
  `).all<ApiTokenRow>();
  return result.results.map(mapApiToken);
}

export async function createApiToken(
  db: D1Database,
  input: { name: string; expiresInDays: number | null; createdByEmail: string },
) {
  const name = input.name.trim();
  if (!name) throw new Error("A token name is required.");
  if (name.length > 80) throw new Error("Token names are limited to 80 characters.");
  if (input.expiresInDays !== null && !ALLOWED_EXPIRATION_DAYS.has(input.expiresInDays)) {
    throw new Error("Choose a valid token expiration.");
  }
  const active = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM todo_api_tokens
    WHERE revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).first<{ count: number }>();
  if (Number(active?.count ?? 0) >= API_TOKEN_LIMIT) {
    throw new Error(`You can keep up to ${API_TOKEN_LIMIT} active API tokens.`);
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const id = crypto.randomUUID();
    const token = `dt_live_${randomSecret()}`;
    const tokenHash = await hashApiToken(token);
    const tokenPrefix = `${token.slice(0, 16)}…`;
    const expiresAt = input.expiresInDays === null
      ? null
      : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
    try {
      const row = await db.prepare(`
        INSERT INTO todo_api_tokens (
          id, name, token_prefix, token_hash, created_by_email, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        RETURNING id, name, token_prefix, created_by_email, created_at, last_used_at, expires_at
      `).bind(id, name, tokenPrefix, tokenHash, input.createdByEmail, expiresAt).first<ApiTokenRow>();
      if (!row) throw new Error("The API token could not be created.");
      console.info("[todo-db] API token created", {
        tokenId: id,
        nameLength: name.length,
        expiresAt,
        attempt,
      });
      return { apiToken: mapApiToken(row), token };
    } catch (error) {
      if (attempt === 3) throw error;
      console.warn("[todo-db] API token collision; retrying", { attempt });
    }
  }
  throw new Error("The API token could not be created.");
}

export async function revokeApiToken(db: D1Database, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("That API token is invalid.");
  const result = await db.prepare(`
    UPDATE todo_api_tokens
    SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND revoked_at IS NULL
  `).bind(id).run();
  const revoked = Number(result.meta.changes ?? 0) > 0;
  console.info("[todo-db] API token revoked", { tokenId: id, revoked });
  return revoked;
}
