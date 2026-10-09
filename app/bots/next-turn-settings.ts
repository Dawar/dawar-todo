import type { SettingsState } from './composer-settings-controller';

/** Presentation of the existing save journal, never evidence of active config. */
export function nextTurnSaveLabel(state: SettingsState, online: boolean) {
  if (state.storageError || state.pending?.phase === 'storage') return 'Save paused';
  if (state.pending?.phase === 'checking') return 'Unconfirmed';
  if (state.pending?.phase === 'saving') return 'Saving';
  if (Object.keys(state.intent).length) return online ? 'Change waiting to save' : 'Unconfirmed';
  if (state.confirmed) return state.confirmationError || !online ? 'Saved · current defaults unconfirmed' : 'Saved for next turn';
  return online ? 'Defaults for future turns' : 'Offline · defaults may be stale';
}
