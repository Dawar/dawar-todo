import { env } from "cloudflare:workers";

export type TwilioPhoneEnvironment = {
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_PHONE_NUMBER?: string;
  TWILIO_MEDIA_STREAM_URL?: string;
};

type IncomingPhoneNumber = {
  sid?: string;
  phone_number?: string;
  voice_url?: string;
  voice_method?: string;
};

function runtime(environment?: TwilioPhoneEnvironment) {
  return environment ?? env as unknown as TwilioPhoneEnvironment;
}

export function twilioPhoneConfig(environment?: TwilioPhoneEnvironment) {
  const current = runtime(environment);
  return {
    accountSid: current.TWILIO_ACCOUNT_SID?.trim() ?? "",
    authToken: current.TWILIO_AUTH_TOKEN?.trim() ?? "",
    phoneNumber: current.TWILIO_PHONE_NUMBER?.trim() ?? "",
  };
}

export function twilioPhoneConfigured(environment?: TwilioPhoneEnvironment) {
  const config = twilioPhoneConfig(environment);
  return Boolean(config.accountSid && config.authToken && config.phoneNumber);
}

export function displayPhoneNumber(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return value;
}

function xmlEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twiml(contents: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${contents}</Response>`;
}

export function twilioXmlResponse(contents: string, status = 200) {
  return twilioDocumentResponse(twiml(contents), status);
}

export function twilioDocumentResponse(document: string, status = 200) {
  return new Response(document, {
    status,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

export function phonePinPromptTwiml(input: {
  actionUrl: string;
  message?: string;
}) {
  const prompt = input.message?.trim()
    || "Dawar Todo. Enter your phone PIN, then press pound.";
  return twiml(
    `<Gather input="dtmf" action="${xmlEscape(input.actionUrl)}" method="POST" `
      + `finishOnKey="#" numDigits="8" timeout="10" actionOnEmptyResult="true">`
      + `<Say>${xmlEscape(prompt)}</Say></Gather><Redirect method="POST">${xmlEscape(input.actionUrl)}</Redirect>`,
  );
}

export function phoneRejectedTwiml(message = "Access denied.") {
  return twiml(`<Say>${xmlEscape(message)}</Say><Hangup/>`);
}

export function phoneUnavailableTwiml() {
  return twiml("<Say>Phone access is not configured. Open Dawar Todo settings to set a phone PIN.</Say><Hangup/>");
}

export function phoneStreamTwiml(input: { streamUrl: string; token: string }) {
  return twiml(
    `<Connect><Stream url="${xmlEscape(input.streamUrl)}">`
      + `<Parameter name="token" value="${xmlEscape(input.token)}"/>`
      + "</Stream></Connect>",
  );
}

export function talkPhoneMediaStreamUrl(
  requestUrl: string,
  environment?: TwilioPhoneEnvironment,
) {
  const configured = runtime(environment).TWILIO_MEDIA_STREAM_URL?.trim();
  const streamUrl = configured
    ? new URL(configured)
    : new URL("/api/talk/phone/stream", requestUrl);
  if (!configured) {
    streamUrl.protocol = streamUrl.protocol === "http:" ? "ws:" : "wss:";
  }
  if (streamUrl.protocol !== "wss:" && streamUrl.protocol !== "ws:") {
    throw new Error("The Twilio media stream URL must use WebSocket transport.");
  }
  if (streamUrl.protocol === "ws:" && !["localhost", "127.0.0.1", "::1"].includes(streamUrl.hostname)) {
    throw new Error("The Twilio media stream URL must use secure WebSocket transport.");
  }
  return streamUrl.toString();
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function hmacSha1Base64(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToBase64(new Uint8Array(signature));
}

function constantTimeTextEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function twilioSignaturePayload(url: string, params?: URLSearchParams | null) {
  if (!params) return url;
  const names = [...new Set([...params.keys()])].sort();
  let payload = url;
  for (const name of names) {
    for (const value of params.getAll(name).sort()) payload += `${name}${value}`;
  }
  return payload;
}

function requestUrlCandidates(request: Request) {
  const requestUrl = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedHost) requestUrl.host = forwardedHost;
  if (forwardedProto === "http" || forwardedProto === "https") requestUrl.protocol = `${forwardedProto}:`;
  const candidates = new Set([requestUrl.toString()]);
  if (requestUrl.protocol === "https:") {
    const websocketUrl = new URL(requestUrl);
    websocketUrl.protocol = "wss:";
    candidates.add(websocketUrl.toString());
  } else if (requestUrl.protocol === "http:") {
    const websocketUrl = new URL(requestUrl);
    websocketUrl.protocol = "ws:";
    candidates.add(websocketUrl.toString());
  }
  return [...candidates];
}

export async function validateTwilioRequest(
  request: Request,
  params?: URLSearchParams | null,
  environment?: TwilioPhoneEnvironment,
) {
  const config = twilioPhoneConfig(environment);
  const signature = request.headers.get("x-twilio-signature")?.trim() ?? "";
  if (!config.authToken || !signature) return false;
  for (const url of requestUrlCandidates(request)) {
    const expected = await hmacSha1Base64(config.authToken, twilioSignaturePayload(url, params));
    if (constantTimeTextEqual(signature, expected)) return true;
  }
  return false;
}

function twilioAuthorization(accountSid: string, authToken: string) {
  return `Basic ${btoa(`${accountSid}:${authToken}`)}`;
}

async function fetchTwilioPhoneNumber(environment?: TwilioPhoneEnvironment) {
  const config = twilioPhoneConfig(environment);
  if (!config.accountSid || !config.authToken || !config.phoneNumber) {
    throw new Error("Twilio phone credentials are incomplete.");
  }
  const url = new URL(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/IncomingPhoneNumbers.json`);
  url.searchParams.set("PhoneNumber", config.phoneNumber);
  const response = await fetch(url, {
    headers: { Authorization: twilioAuthorization(config.accountSid, config.authToken) },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({})) as {
    incoming_phone_numbers?: IncomingPhoneNumber[];
    message?: string;
  };
  if (!response.ok) throw new Error(body.message || `Twilio phone lookup failed (${response.status}).`);
  const match = body.incoming_phone_numbers?.find((number) => number.phone_number === config.phoneNumber)
    ?? body.incoming_phone_numbers?.[0];
  if (!match?.sid) throw new Error("The configured Twilio phone number was not found in this account.");
  return { config, number: match };
}

export async function configureTwilioVoiceWebhook(
  webhookUrl: string,
  environment?: TwilioPhoneEnvironment,
) {
  const startedAt = Date.now();
  const { config, number } = await fetchTwilioPhoneNumber(environment);
  const payload = new URLSearchParams({
    VoiceUrl: webhookUrl,
    VoiceMethod: "POST",
  });
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.accountSid)}/IncomingPhoneNumbers/${encodeURIComponent(number.sid!)}.json`,
    {
      method: "POST",
      headers: {
        Authorization: twilioAuthorization(config.accountSid, config.authToken),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: payload,
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = await response.json().catch(() => ({})) as IncomingPhoneNumber & { message?: string };
  if (!response.ok) throw new Error(body.message || `Twilio phone setup failed (${response.status}).`);
  console.info("[todo-talk-phone] Twilio number webhook configured", {
    phoneNumberSuffix: config.phoneNumber.replace(/\D/g, "").slice(-4),
    webhookHost: new URL(webhookUrl).host,
    durationMs: Date.now() - startedAt,
  });
  return {
    phoneNumber: config.phoneNumber,
    webhookUrl: body.voice_url ?? webhookUrl,
    voiceMethod: body.voice_method ?? "POST",
  };
}
