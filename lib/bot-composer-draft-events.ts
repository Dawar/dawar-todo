import { notifyBotSetting, botSettingEvents } from './bot-settings-events';
export function notifyComposerDraft(owner: string, botId: string) {
  notifyBotSetting('composer-draft', owner, botId);
}
export function composerDraftEvents(owner: string, botId: string, signal: AbortSignal) {
  return botSettingEvents('composer-draft', owner, botId, signal);
}
