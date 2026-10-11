export type BotTicket = {
  role: "browser";
  owner: string;
  machineId: string;
  jti: string;
  exp: number;
  sessionExp: number;
};
export type TaskRequestTicket = Omit<BotTicket,'role'> & {
  role:'task-request'; botId:string; threadId:string;
  binding:import('./task-requests').TaskRequestSecureBinding;
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
export async function signTaskRequestTicket(payload:TaskRequestTicket,secret:string) {
  // Dedicated role is signed identically, but owner-ticket verification rejects it.
  return signBotTicket(payload as unknown as BotTicket,secret);
}
export async function verifyTaskRequestTicket(token:string,secret:string,machineId:string,current=Math.floor(Date.now()/1000)):Promise<TaskRequestTicket> {
  if(typeof token!=='string'||token.length>4096)throw Error('Invalid guest ticket.');
  const [body,signature,extra]=token.split('.');if(!body||!signature||extra)throw Error('Invalid guest ticket.');
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  if(!await crypto.subtle.verify('HMAC',key,decode(signature),encoder.encode(body)))throw Error('Invalid guest ticket.');
  const p=JSON.parse(new TextDecoder().decode(decode(body))) as TaskRequestTicket;
  const id=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,180}$/.test(v);
  if(p.role!=='task-request'||!p.owner||p.machineId!==machineId||!id(p.jti)||!id(p.botId)||!id(p.threadId)||!p.binding||!id(p.binding.requestId)||!id(p.binding.grantId)||!id(p.binding.submissionId)||!Number.isSafeInteger(p.binding.revision)||p.binding.revision<1||!Number.isFinite(p.exp)||p.exp<current||p.exp>current+90||!Number.isFinite(p.sessionExp)||p.sessionExp<current||p.sessionExp>current+960)throw Error('Guest ticket expired or invalid.');
  return p;
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
  environment: {
    BOTS_OWNER_EMAIL?: string;
    BOTS_OWNER_USER_ID?: string;
    BOTS_DEV_AUTH?: string;
    BOTS_PUBLIC_ORIGIN?: string;
  },
) {
  const owner = environment.BOTS_OWNER_EMAIL?.trim().toLowerCase();
  if (!owner) throw new Error("Bots are not configured.");
  const ownerUserId = environment.BOTS_OWNER_USER_ID?.trim();
  if (!ownerUserId) throw new Error("Bots owner identity is not configured.");
  if (request.headers.has("Authorization"))
    throw new Error("Bots require the owner's signed-in session.");
  const url = new URL(request.url);
  // The portable gateway forwards over loopback, so Next's request URL uses
  // its internal listener. Compare the browser against the fixed server
  // configuration, never against client-supplied forwarded headers.
  let expectedOrigin = url.origin;
  if (environment.BOTS_PUBLIC_ORIGIN !== undefined) {
    const configured = new URL(environment.BOTS_PUBLIC_ORIGIN);
    if (configured.protocol !== "https:" || configured.username || configured.password ||
      configured.pathname !== "/" || configured.search || configured.hash)
      throw new Error("Invalid configured bots origin.");
    expectedOrigin = configured.origin;
  }
  const origin = request.headers.get("Origin");
  if (origin && origin !== expectedOrigin)
    throw new Error("Invalid request origin.");
  if (
    environment.BOTS_DEV_AUTH === "1" &&
    ["localhost", "127.0.0.1"].includes(url.hostname)
  )
    return owner;
  const userId = request.headers.get("oai-authenticated-user-id")?.trim();
  if (userId !== ownerUserId)
    throw new Error("Bots are available only to the owner.");
  return owner;
}
