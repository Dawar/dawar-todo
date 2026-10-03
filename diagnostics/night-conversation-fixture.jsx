// Manual, disposable preview of the real workspace. No assertions or test runner.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BotsWorkspace } from '../app/bots/workspace';
import { botsClient as client } from '../app/bots/client';
import { getBotTimeline } from '../app/bots/use-timeline';
client.start = () => {};
client.owner = `night-preview-${crypto.randomUUID()}`;
client.online = true;
const calls = [];
client.rpc = async (method, botId, params) => {
  if (!client.online) throw Error('This disposable preview is offline.');
  const begin = performance.now();
  const response = await fetch('/rpc', { method:'POST', body:JSON.stringify({ method, botId, params }) }).then(r=>r.json());
  if (response.error) throw Error(response.error);
  calls.push({ method, params, bytes:new TextEncoder().encode(JSON.stringify(response.result)).length, ms:performance.now()-begin });
  return response.result;
};
fetch('/fixture').then(r=>r.json()).then(snapshot => {
  client.snapshot = snapshot;
  history.replaceState({}, '', '/preview?bot=night-studio');
  createRoot(document.getElementById('root')).render(<BotsWorkspace />);
});
window.night = {
  client, calls,
  timeline: () => getBotTimeline(client.owner,'night-studio'),
  offline(value=true) { client.online=!value; client.notify(); },
};
