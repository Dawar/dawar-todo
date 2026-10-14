import {invalidatePortableSession} from './portable-session';
import {portableHeaders} from './portable-csrf';

export const SIGNED_OUT_KEY = "dawar-portable-signed-out";
export const SIGNED_OUT_EVENT = "dawar-portable-sign-out";
export const SIGNED_OUT_PATH = "/signout-with-chatgpt";

export function signOutChannel() {
  try { return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(SIGNED_OUT_EVENT); }
  catch { return null; }
}

export function portableSignedOut() {
  try { if (localStorage.getItem(SIGNED_OUT_KEY)) return true; } catch { /* Private storage can be unavailable. */ }
  // This readable cookie is a CSRF convenience, not proof of authentication.
  // Safari expiry or an offline cached page cannot decide server identity.
  return false;
}

export function preparePortableSignIn() {
  try { localStorage.removeItem(SIGNED_OUT_KEY); } catch { /* The session cookie remains authoritative. */ }
}

export function notifySignedOut() {
  invalidatePortableSession();
  try { localStorage.setItem(SIGNED_OUT_KEY, String(Date.now())); } catch { /* Keep the current tab safe without storage. */ }
  const channel = signOutChannel();
  try { channel?.postMessage("signed-out"); } catch { /* Session revocation still protects other tabs. */ }
  finally { channel?.close(); }
  window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  if(window.location.pathname!==SIGNED_OUT_PATH)window.location.replace(SIGNED_OUT_PATH);
}

export async function signOutPortableSession() {
  try {
  const csrf=portableHeaders().get('x-dawar-csrf');
  if(!csrf){notifySignedOut();return;}
  const response = await fetch("/auth/logout", {
    method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { "x-dawar-csrf": csrf }, signal: AbortSignal.timeout(3000),
  });
  if (response.status !== 204 && response.status !== 401) throw new Error("Sign out was not confirmed. Please try again.");
  notifySignedOut();
  } catch {
    // Local sign-out and the public sign-in route always remain usable. An
    // unavailable server does not confirm remote revocation or delete drafts.
    notifySignedOut();
  }
}
