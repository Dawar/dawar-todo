// Identical message text/turn counts/tool payloads to the reviewed 7c578085 baseline.
export function botFixture(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `synthetic-bot-${i}`, name: `Synthetic bot ${i}`, purpose: 'Synthetic purpose', slug: `synthetic-${i}`,
    cwd: '/synthetic', threadId: `thread-${i}`, color: '#276b58', status: 'idle', archived: false, model: null, effort: null, mode: 'default', preview: 'Synthetic preview',
    updatedAt: '2026-09-26T12:00:00Z', lastReadAt: '2026-09-26T12:00:00Z', activeTurnId: null }));
}
export function chatTurns(botId, count, messages = 1, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({ id: `chat-turn-${i + offset}`, status: 'completed', itemsView: 'full', error: null,
    startedAt: 1, completedAt: 2, durationMs: 1,
    items: Array.from({ length: messages }, (_, j) => ({ id: `chat-item-${i + offset}-${j}`, type: 'agentMessage', phase: 'final_answer',
      text: `**${botId} turn ${i + offset} message ${j}**\n\n` + 'Synthetic message text with **emphasis**, `code`, and [local example](#example). '.repeat(16)
        + (i === count - 1 && j === messages - 1 ? `\n\n${botId}:latest` : '') })) }));
}
export function fixture(botId, options) {
  const turns = chatTurns(botId, 20, options.messages ?? 1), attachments = [];
  if (options.tools) {
    turns.at(-1).items.unshift(...Array.from({ length: options.tools }, (_, i) => ({ type: 'commandExecution', id: `tool-${i}`, command: 'synthetic command', cwd: '/synthetic', status: 'completed', commandActions: [], aggregatedOutput: 'Synthetic tool output.\n'.repeat(1490), exitCode: 0, durationMs: 10 })));
    turns[0].items.unshift({ type: 'userMessage', id: 'scheduled-input', clientId: 'schedule:synthetic', content: [{ type: 'text', text: 'Synthetic scheduled run' }] });
    for (let i = 0; i < 3; i++) {
      attachments.push({ id: `synthetic-image-${i}`, botId, name: 'synthetic.svg', mimeType: 'image/svg+xml', size: 80, ready: true, path: `/synthetic/image-${i}.svg` });
      turns[0].items[0].content.push({ type: 'localImage', path: `/synthetic/image-${i}.svg` });
    }
  }
  if (options.lateImages) {
    const id = 'delayed-image', path = '/synthetic/delayed.svg';
    attachments.push({ id, botId, name: 'delayed.svg', mimeType: 'image/svg+xml', size: 80, ready: true, path });
    turns[18].items.unshift({ type: 'userMessage', id: 'image-input', content: [{ type: 'localImage', path }] });
  }
  if (options.hugeAnswer) turns.at(-1).items.push({ type: 'agentMessage', id: 'huge-answer', text: 'Full answer text. '.repeat(20000) + 'COMPLETE-END', phase: 'final_answer' });
  return { turns: [...chatTurns(botId, 20, 1, -20), ...turns], attachments };
}
export const snapshotFor = (n) => ({ bots: botFixture(n), pending: [], cursor: 0, ready: true, account: { authenticated: true },
  defaults: { model: 'synthetic-model', effort: 'medium', serviceTier: 'default' }, models: [], schedules: [], runs: [] });
