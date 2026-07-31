"use client";

export function pushApplicationServerKey(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = window.atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function sameBytes(left: ArrayBuffer | null, right: Uint8Array) {
  if (!left) return false;
  const actual = new Uint8Array(left);
  if (actual.length !== right.length) return false;
  return actual.every((value, index) => value === right[index]);
}

export function pushSubscriptionUsesKey(subscription: PushSubscription, publicKey: string) {
  const expected = pushApplicationServerKey(publicKey);
  return sameBytes(subscription.options?.applicationServerKey ?? null, expected);
}

export async function ensureCurrentPushSubscription(
  registration: ServiceWorkerRegistration,
  publicKey: string,
  options: { forceRenew?: boolean } = {},
) {
  let existing = await registration.pushManager.getSubscription();
  const keyMatches = existing ? pushSubscriptionUsesKey(existing, publicKey) : false;
  const shouldRenew = Boolean(existing && (options.forceRenew || !keyMatches));
  if (shouldRenew) {
    await existing!.unsubscribe();
    console.info("[todo-push] stale browser subscription removed", {
      forced: Boolean(options.forceRenew),
      applicationServerKeyMatched: keyMatches,
    });
    existing = null;
  }
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: pushApplicationServerKey(publicKey),
  });
  return {
    subscription,
    reused: Boolean(existing),
    renewed: shouldRenew,
  };
}
