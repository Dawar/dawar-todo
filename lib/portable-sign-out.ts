export const SIGNED_OUT_KEY = "dawar-portable-signed-out";
export const SIGNED_OUT_EVENT = "dawar-portable-sign-out";
export const SIGNED_OUT_PATH = "/signout-with-chatgpt";

export function portableSignedOut() {
  try { if (localStorage.getItem(SIGNED_OUT_KEY)) return true; } catch { /* Private storage can be unavailable. */ }
  return !document.cookie.split(";").some((part) => /^__Host-dawar-csrf=[A-Za-z0-9_-]{43}$/.test(part.trim()));
}

export function preparePortableSignIn() {
  try { localStorage.removeItem(SIGNED_OUT_KEY); } catch { /* The session cookie remains authoritative. */ }
}

function notifySignedOut() {
  try { localStorage.setItem(SIGNED_OUT_KEY, String(Date.now())); } catch { /* Keep the current tab safe without storage. */ }
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(SIGNED_OUT_EVENT);
    channel.postMessage("signed-out");
    channel.close();
  }
  window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  window.location.replace(SIGNED_OUT_PATH);
}

export async function signOutPortableSession() {
  const session = await fetch("/auth/session", {
    credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (session.status === 401) { notifySignedOut(); return; }
  if (!session.ok) throw new Error("Could not check your session. Please try again.");
  const value = await session.json() as { csrf?: string };
  if (typeof value.csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.csrf)) throw new Error("Could not verify your session. Refresh and try again.");
  const response = await fetch("/auth/logout", {
    method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { "x-dawar-csrf": value.csrf }, signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 204 && response.status !== 401) throw new Error("Sign out was not confirmed. Please try again.");
  notifySignedOut();
}
