export const INTERNAL_ACTOR_KIND_HEADER = "x-dawar-internal-actor-kind";
export const INTERNAL_ACTOR_ID_HEADER = "x-dawar-internal-actor-id";
export const INTERNAL_ACTOR_NAME_HEADER = "x-dawar-internal-actor-name";
export const INTERNAL_ACTOR_USER_KEY_HEADER = "x-dawar-internal-actor-user-key";

export const INTERNAL_ACTOR_HEADERS = [
  INTERNAL_ACTOR_KIND_HEADER,
  INTERNAL_ACTOR_ID_HEADER,
  INTERNAL_ACTOR_NAME_HEADER,
  INTERNAL_ACTOR_USER_KEY_HEADER,
] as const;

export function apiTokenActorFromRequest(request: Request) {
  if (request.headers.get(INTERNAL_ACTOR_KIND_HEADER) !== "api-token") return null;
  const id = request.headers.get(INTERNAL_ACTOR_ID_HEADER)?.trim() ?? "";
  const encodedName = request.headers.get(INTERNAL_ACTOR_NAME_HEADER)?.trim() ?? "";
  let name = "";
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    return null;
  }
  const userKey = request.headers.get(INTERNAL_ACTOR_USER_KEY_HEADER)?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || !name || !userKey) return null;
  return { kind: "api-token" as const, id, name, userKey };
}
