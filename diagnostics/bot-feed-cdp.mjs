// Small interactive CDP helper; does not run scenarios or assertions itself.
import { readFile, writeFile } from 'node:fs/promises';
export async function connect() {
  const info = JSON.parse(await readFile('outputs/bot-typing-recent/connection.json', 'utf8'));
  const socket = new WebSocket(info.socket);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let seq = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const request = pending.get(message.id); pending.delete(message.id);
    if (message.error) request.reject(Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  return { info, send,
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    async capture(name) { await writeFile(`outputs/bot-typing-recent/${name}.png`, Buffer.from((await send('Page.captureScreenshot')).data, 'base64')); },
    close() { socket.close(); },
  };
}
