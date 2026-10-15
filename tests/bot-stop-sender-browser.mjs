// Inspection server: real workspace, synthetic transport only (see fixture).
// Usage: node tests/bot-stop-sender-browser.mjs [port]   then open /harness
import { createServer } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['tests/fixtures/bot-stop-sender-browser.jsx'], bundle: true, write: false, outdir: 'outputs/browser-test', format: 'esm', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@': '.' },
  plugins: [{ name: 'synthetic-shell', setup(builder) { builder.onLoad({ filter: /app\/site-header\.tsx$/ }, () => ({ contents: 'export function SiteHeader(){return null}', loader: 'tsx' }));
    builder.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'asset-url' }));
    builder.onLoad({ filter: /.*/, namespace: 'asset-url' }, () => ({ contents: 'export default ""', loader: 'js' })); } }], logLevel: 'error' });
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
const appCss = readdirSync('dist/server/assets').filter(name => /^index-.*\.css$/.test(name)).map(name => readFileSync(`dist/server/assets/${name}`, 'utf8')).join('\n');
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  if (path === '/harness.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js); }
  else if (path === '/harness.css') { res.setHeader('Content-Type', 'text/css'); res.end(`${appCss}\n${css}`); }
  else res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"><body style="margin:0;font-family:system-ui,sans-serif"><div id="root"></div><script type="module" src="/harness.js"></script>');
});
server.listen(Number(process.argv[2] ?? 4791), '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}/harness`));
// With an output directory, also write headless screenshots and exit.
if (process.argv[3]) {
  const { spawn } = await import('node:child_process'), { mkdirSync } = await import('node:fs');
  const out = process.argv[3]; mkdirSync(out, { recursive: true });
  await new Promise(done => server.listening ? done() : server.once('listening', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const shot = (name, size, query) => new Promise((done, fail) => {
    const chrome = spawn(process.env.BOT_TEST_CHROME ?? 'google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--window-size=${size}`, '--virtual-time-budget=5000', `--screenshot=${out}/${name}.png`, `${origin}/harness?${query}`], { stdio: 'ignore' });
    chrome.on('exit', code => code === 0 ? done() : fail(Error(`${name}: chrome ${code}`)));
  });
  try {
    await shot('desktop-1280-queue-stop', '1280,820', '');
    await shot('desktop-1280-confirm', '1280,820', 'confirm');
    await shot('desktop-1280-stopped-header', '1280,820', 'bot=adele');
    await shot('mobile-390-confirm', '390,844', 'confirm');
    await shot('mobile-320-chat', '320,640', '');
    await shot('mobile-390-stopped-header', '390,844', 'bot=adele');
    console.log(out);
  } finally { server.close(); }
}
