// @ts-check
// Compile-time only (tsconfig.bridge.json): an absent or optional ID passed to
// the store is a type error. Oct 15: recovery looked up a releaseActionId that
// a pre-restart failure never created, and every pass failed at run time.

/**
 * @param {import('../../bot-bridge/store.mjs').Store} store
 * @param {import('../../bot-bridge/store.mjs').NativeErrorRecoveryRecord} row
 */
export function lookups(store, row) {
  // @ts-expect-error An optional reference must be guarded before the lookup.
  store.get('nativeRecoveryAction', row.releaseActionId);
  // @ts-expect-error An undefined ID is never a valid key.
  store.get('botActivity', undefined);
  // @ts-expect-error Neither is null.
  store.list('promptQueue', null).map(item => store.get('primaryInbox', item.turnId));
  // @ts-expect-error A record needs its ID.
  store.put('botActivity', { botId: 'bot-1', generation: 0 });
  // Guarded lookups type-check, and their results are typed.
  const action = row.releaseActionId ? store.get('nativeRecoveryAction', row.releaseActionId) : null;
  /** @type {string|undefined} */ const state = action?.state;
  return state;
}
