import { replayableStorageFetch } from "./storage-transfer";
/** Private SigV4 signing shared by Todo and bot storage. Never send this environment to clients. */
export type S3Environment = { S3_ACCESS_KEY: string; S3_ACCESS_KEY_ID: string; S3_BUCKET: string; S3_ENDPOINT_URL: string };
type StorageConfig = { bucket: string; endpoint: URL; region: string };
export class PrivateStorageError extends Error {
  readonly attachmentPhase = "storage";
  readonly code = "storage-unavailable";
  constructor(public readonly status: number, public readonly providerCode: string | null) {
    super("Private storage verification failed. Retry the same attachment; local bytes are retained.");
  }
}
/** Read an open-ended range but retain at most 64 KiB. Small objects must not
 * be requested past their end; size and magic bytes come from one response. */
export async function readStoragePrefix(response: Response) {
  const range = response.headers.get("content-range")?.match(/^bytes 0-(\d+)\/(\d+)$/i);
  const size = response.status === 206 && range ? Number(range[2])
    : response.status === 200 && response.headers.has("content-length") ? Number(response.headers.get("content-length")) : NaN;
  const length = Math.min(size, 65536);
  const encoding = response.headers.get("content-encoding");
  if (!Number.isSafeInteger(size) || size < 1 || encoding && encoding !== "identity"
    || response.status === 206 && (!range || Number(range[1]) < length - 1 || Number(range[1]) >= size)) {
    await response.body?.cancel().catch(() => {});
    throw new PrivateStorageError(502, "InvalidObjectMetadata");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new PrivateStorageError(502, "MissingObjectBody");
  const bytes = new Uint8Array(length); let offset = 0;
  try {
    while (offset < length) {
      const next = await reader.read();
      if (next.done) throw new PrivateStorageError(502, "IncompleteObjectBody");
      const part = next.value.subarray(0, length - offset); bytes.set(part, offset); offset += part.length;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return { bytes, size };
}
/** Provider diagnostics are categories only: never XML, keys, URLs or credentials. */
export async function storageResponseMetadata(response: Response) {
  if (response.ok) return { status: response.status, code: null, argument: null, reason: null };
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    if (reader) for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length; if (size > 64 * 1024) break;
      chunks.push(next.value);
    }
  } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0)); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const xml = new TextDecoder().decode(bytes);
  const code = xml.match(/<Code>([A-Za-z0-9]{1,80})<\/Code>/)?.[1] ?? null;
  const argumentValue = xml.match(/<ArgumentName>([^<]{1,80})<\/ArgumentName>/)?.[1];
  const argument = ["Range", "Authorization", "x-amz-content-sha256", "x-amz-date", "SignedHeaders", "Credential"].includes(argumentValue ?? "") ? argumentValue! : null;
  const message = xml.match(/<Message>([^<]{0,2048})<\/Message>/)?.[1] ?? "";
  const reason = /range/i.test(message) ? "range" : /signed.?headers/i.test(message) ? "signed-headers"
    : /sha256|payload.*hash/i.test(message) ? "payload-hash" : /authorization/i.test(message) ? "authorization"
    : /signature/i.test(message) ? "signature" : /credential/i.test(message) ? "credential"
    : /content.?length/i.test(message) ? "content-length" : /\bhost\b/i.test(message) ? "host"
    : /date|expir|request.*time/i.test(message) ? "time" : "other";
  return { status: response.status, code, argument, reason };
}
const SIGNED_URL_SECONDS = 60 * 60;
export function createS3Storage(environment: S3Environment) {
  let cachedStorageConfig: StorageConfig | null = null;
function storageConfig() {
  if (cachedStorageConfig) return cachedStorageConfig;
  const current = environment;
  const missing = [
    "S3_ACCESS_KEY",
    "S3_ACCESS_KEY_ID",
    "S3_BUCKET",
    "S3_ENDPOINT_URL",
  ].filter((key) => !current[key as keyof S3Environment]);
  if (missing.length) throw new Error(`Image storage is missing ${missing.join(", ")}.`);
  const endpointValue = /^https?:\/\//i.test(current.S3_ENDPOINT_URL)
    ? current.S3_ENDPOINT_URL
    : `https://${current.S3_ENDPOINT_URL}`;
  const endpointUrl = new URL(endpointValue);
  const bucketPrefix = `${current.S3_BUCKET}.`;
  if (endpointUrl.hostname.startsWith(bucketPrefix)) endpointUrl.hostname = endpointUrl.hostname.slice(bucketPrefix.length);
  endpointUrl.pathname = "/";
  endpointUrl.search = "";
  endpointUrl.hash = "";
  const endpointRegion = endpointUrl.hostname.endsWith(".digitaloceanspaces.com")
    ? endpointUrl.hostname.split(".")[0]
    : "us-east-1";
  // DigitalOcean's JavaScript S3 guidance uses the AWS-compatible signing
  // region while the physical Spaces region remains encoded in the endpoint.
  const signingRegion = endpointUrl.hostname.endsWith(".digitaloceanspaces.com")
    ? "us-east-1"
    : endpointRegion;
  cachedStorageConfig = {
    bucket: current.S3_BUCKET,
    endpoint: endpointUrl,
    region: signingRegion,
  };
  return cachedStorageConfig;
}

function storageUrl(key?: string, query?: Record<string, string>) {
  const { bucket, endpoint } = storageConfig();
  const url = new URL(endpoint);
  url.hostname = `${bucket}.${url.hostname}`;
  url.pathname = key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : "/";
  Object.entries(query ?? {}).forEach(([name, value]) => url.searchParams.set(name, value));
  return url;
}

async function signedStorageResponse(url: URL, init?: RequestInit) {
  const method = init?.method ?? "GET";
  const { bucket, endpoint } = storageConfig();
  const serverUrl = new URL(url);
  serverUrl.hostname = endpoint.hostname;
  serverUrl.pathname = `/${encodeURIComponent(bucket)}${url.pathname}`;
  const request = await signedHeaderRequest(serverUrl, method, init?.headers);
  return ["GET","HEAD","PUT"].includes(method) ? replayableStorageFetch(fetch,request,{signal:init?.signal}) : fetch(request,{signal:init?.signal});
}

async function storageFetch(url: URL, init?: RequestInit) {
  const response = await signedStorageResponse(url, init);
  if (!response.ok) throw await storageResponseError("Private image storage", response);
  return response;
}

async function storageResponseError(stage: string, response: Response) {
  const details = await storageResponseMetadata(response);
  console.error("[todo-attachments] storage request failed", {
    stage,
    ...details,
    requestId: response.headers.get("x-amz-request-id"),
  });
  return new PrivateStorageError(response.status, details.code);
}

async function deleteKeys(keys: string[]) {
  await Promise.all([...new Set(keys.filter(Boolean))].map(async (key) => {
    const response = await signedStorageResponse(storageUrl(key), { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw await storageResponseError("Private image cleanup", response);
  }));
}

async function signedObjectUrl(key: string, downloadName?: string) {
  const url = storageUrl(key, {
    ...(downloadName ? { "response-content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}` } : {}),
  });
  return signedQueryUrl(url, "GET", SIGNED_URL_SECONDS);
}

function hmac(key: string | ArrayBuffer, value: string) {
  const bytes = typeof key === "string" ? new TextEncoder().encode(key) : key;
  return crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    .then((cryptoKey) => crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value)));
}

function hex(value: ArrayBuffer) {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function awsEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function signatureKey(date: string, region: string) {
  return hmac(`AWS4${environment.S3_ACCESS_KEY}`, date)
    .then((dateKey) => hmac(dateKey, region))
    .then((regionKey) => hmac(regionKey, "s3"))
    .then((serviceKey) => hmac(serviceKey, "aws4_request"));
}

async function sha256Hex(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function signedHeaderRequest(input: URL, method: string, inputHeaders?: HeadersInit) {
  const current = environment;
  const { region } = storageConfig();
  const url = new URL(input);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const payloadHash = await sha256Hex("");
  const headers = new Headers(inputHeaders);
  headers.set("x-amz-content-sha256", payloadHash);
  headers.set("x-amz-date", amzDate);
  const canonicalPath = url.pathname.split("/").map((segment) => {
    try { return awsEncode(decodeURIComponent(segment)); } catch { return awsEncode(segment); }
  }).join("/");
  const canonicalQuery = [...url.searchParams]
    .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
    .sort(([nameA, valueA], [nameB, valueB]) => nameA < nameB ? -1 : nameA > nameB ? 1 : valueA < valueB ? -1 : valueA > valueB ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonical = [...headers.entries()].map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")]);
  canonical.push(["host", url.host]); canonical.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const signedHeaders = canonical.map(([name]) => name).join(";");
  const canonicalHeaders = canonical.map(([name, value]) => `${name}:${value}\n`).join("");
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signature = hex(await hmac(await signatureKey(date, region), stringToSign));
  headers.set("Authorization", `AWS4-HMAC-SHA256 Credential=${current.S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
  return new Request(url, { method, headers });
}

async function signedQueryUrl(input: URL, method: string, expires: number) {
  const current = environment;
  const { region } = storageConfig();
  const url = new URL(input);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${current.S3_ACCESS_KEY_ID}/${scope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(expires));
  url.searchParams.set("X-Amz-SignedHeaders", "host");
  const canonicalPath = url.pathname.split("/").map((segment) => {
    try { return awsEncode(decodeURIComponent(segment)); } catch { return awsEncode(segment); }
  }).join("/");
  const canonicalQuery = [...url.searchParams]
    .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
    .sort(([nameA, valueA], [nameB, valueB]) => nameA < nameB ? -1 : nameA > nameB ? 1 : valueA < valueB ? -1 : valueA > valueB ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    `host:${url.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const requestHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalRequest));
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(requestHash)].join("\n");
  url.searchParams.set("X-Amz-Signature", hex(await hmac(await signatureKey(date, region), stringToSign)));
  return url.toString().replaceAll("+", "%20");
}

async function signedPostTarget(key: string, contentType: string, maximumBytes: number, minimumBytes = 1) {
  const current = environment;
  const { bucket, endpoint, region } = storageConfig();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const credential = `${current.S3_ACCESS_KEY_ID}/${date}/${region}/s3/aws4_request`;
  const fields = {
    key,
    "Content-Type": contentType,
    success_action_status: "204",
    "x-amz-algorithm": "AWS4-HMAC-SHA256",
    "x-amz-credential": credential,
    "x-amz-date": amzDate,
  };
  const policy = btoa(JSON.stringify({
    expiration: new Date(now.valueOf() + 15 * 60 * 1000).toISOString(),
    conditions: [
      { bucket },
      { key },
      { "Content-Type": contentType },
      { success_action_status: "204" },
      { "x-amz-algorithm": fields["x-amz-algorithm"] },
      { "x-amz-credential": credential },
      { "x-amz-date": amzDate },
      ["content-length-range", minimumBytes, maximumBytes],
    ],
  }));
  const signingKey = await signatureKey(date, region);
  return {
    url: new URL(`https://${bucket}.${endpoint.hostname}/`).toString(),
    fields: { ...fields, policy, "x-amz-signature": hex(await hmac(signingKey, policy)) },
  };
}


  async function copyObject(source: string, target: string, etag: string) {
    const response = await storageFetch(storageUrl(target), { method: "PUT", headers: {
      "x-amz-copy-source": `/${awsEncode(environment.S3_BUCKET)}/${source.split("/").map(awsEncode).join("/")}`,
      "x-amz-copy-source-if-match": etag,
      "x-amz-metadata-directive": "COPY",
    } });
    const result = await response.text();
    if (/<Error[>\s]/.test(result) || !/<CopyObjectResult[>\s]/.test(result)) throw new Error("Private storage did not confirm the copy.");
  }
  // Read the existing provider configuration with the server's existing key.
  // No secret/key/URL is returned and no bucket configuration is changed.
  async function readBucketCors() {
    const response = await signedStorageResponse(storageUrl(undefined, { cors: "" }), { signal: AbortSignal.timeout(10000) });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) {
      try { for (;;) { const next = await reader.read(); if (next.done) break;
        size += next.value.length; if (size > 64 * 1024) throw new Error("Provider configuration response exceeds its bound."); chunks.push(next.value);
      } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const xml = new TextDecoder().decode(bytes);
    const code = xml.match(/<Code>([A-Za-z0-9]{1,80})<\/Code>/)?.[1] ?? null;
    if (!response.ok) return { http: response.status, code, configured: code === "NoSuchCORSConfiguration" ? false : null, rules: [] };
    if (!/<CORSConfiguration[>\s]/.test(xml)) throw new Error("Invalid provider CORS response.");
    const decode = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    const rules = [...xml.matchAll(/<CORSRule(?:\s[^>]*)?>([\s\S]*?)<\/CORSRule>/g)].map(match => {
      const values = (tag: string) => [...match[1].matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))].map(item => decode(item[1]));
      const maxAge = values("MaxAgeSeconds")[0];
      return { allowedOrigins: values("AllowedOrigin"), allowedMethods: values("AllowedMethod"), allowedHeaders: values("AllowedHeader"), exposeHeaders: values("ExposeHeader"), maxAgeSeconds: maxAge && /^\d+$/.test(maxAge) ? Number(maxAge) : null };
    });
    return { http: response.status, code: null, configured: true, rules };
  }
  return { storageUrl, signedStorageResponse, storageFetch, signedObjectUrl, signedPostTarget, copyObject, deleteKeys, storageResponseError, readBucketCors };
}
