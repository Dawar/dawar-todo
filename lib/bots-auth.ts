export type BotTicket = {
  role: "browser";
  owner: string;
  machineId: string;
  jti: string;
  exp: number;
  sessionExp: number;
};
const encoder = new TextEncoder();
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function decode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(
    atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    (c) => c.charCodeAt(0),
  );
}
export async function signBotTicket(payload: BotTicket, secret: string) {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `${body}.${base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body))))}`;
}
export async function verifyBotTicket(
  token: string,
  secret: string,
  machineId: string,
  current = Math.floor(Date.now() / 1000),
): Promise<BotTicket> {
  if (typeof token !== "string" || token.length > 4096)
    throw new Error("Invalid ticket.");
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) throw new Error("Invalid ticket.");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      key,
      decode(signature),
      encoder.encode(body),
    ))
  )
    throw new Error("Invalid ticket.");
  const payload = JSON.parse(
    new TextDecoder().decode(decode(body)),
  ) as BotTicket;
  if (
    payload.role !== "browser" ||
    !payload.owner ||
    payload.machineId !== machineId ||
    !payload.jti ||
    !Number.isFinite(payload.exp) ||
    payload.exp < current ||
    payload.exp > current + 90 ||
    !Number.isFinite(payload.sessionExp) ||
    payload.sessionExp < current ||
    payload.sessionExp > current + 960
  )
    throw new Error("Ticket expired or invalid.");
  return payload;
}
export async function secretMatches(a: string, b: string) {
  if (!a || !b) return false;
  const [x, y] = await Promise.all(
    [a, b].map((value) =>
      crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
  const left = new Uint8Array(x),
    right = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
export function botsOwner(
  request: Request,
  environment: { BOTS_OWNER_EMAIL?: string; BOTS_DEV_AUTH?: string },
) {
  const owner = environment.BOTS_OWNER_EMAIL?.trim().toLowerCase();
  if (!owner) throw new Error("Bots are not configured.");
  if (request.headers.has("Authorization"))
    throw new Error("Bots require the owner's signed-in session.");
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin)
    throw new Error("Invalid request origin.");
  if (
    environment.BOTS_DEV_AUTH === "1" &&
    ["localhost", "127.0.0.1"].includes(url.hostname)
  )
    return owner;
  const email = request.headers
    .get("oai-authenticated-user-email")
    ?.trim()
    .toLowerCase();
  if (email !== owner) throw new Error("Bots are available only to the owner.");
  return owner;
}
