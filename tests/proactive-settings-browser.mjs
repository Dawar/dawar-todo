// Screenshot harness for Proactive bots settings: real components, synthetic transport only.
// Usage: node tests/proactive-settings-browser.mjs <output-dir>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const out = resolve(process.argv[2] ?? 'outputs/proactive-settings-browser');
await mkdir(out, { recursive: true });
const bundle = await build({ entryPoints: ['tests/fixtures/proactive-settings-browser.jsx'], bundle: true, write: false, outdir: 'outputs/browser-test', format: 'esm', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@': '.' },
  plugins: [{ name: 'synthetic-shell', setup(builder) { builder.onLoad({ filter: /app\/site-header\.tsx$/ }, () => ({ contents: 'export function SiteHeader(){return null}', loader: 'tsx' }));
    builder.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'asset-url' }));
    builder.onLoad({ filter: /.*/, namespace: 'asset-url' }, () => ({ contents: 'export default ""', loader: 'js' })); } }], logLevel: 'error' });
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
// The compiled app stylesheet (Tailwind + tokens) comes from the last build.
const fs = await import('node:fs');
const appCss = fs.readdirSync('dist/server/assets').filter(name => /^index-.*\.css$/.test(name)).map(name => fs.readFileSync(`dist/server/assets/${name}`, 'utf8')).join('\n');
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  if (path === '/harness.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js); }
  else if (path === '/harness.css') { res.setHeader('Content-Type', 'text/css'); res.end(`${appCss}\n${css}`); }
  else res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"><body style="margin:0;font-family:system-ui,sans-serif"><div id="root"></div><script type="module" src="/harness.js"></script>');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const shot = (name, size, query) => new Promise((done, fail) => {
  const chrome = spawn(process.env.BOT_TEST_CHROME ?? 'google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--window-size=${size}`, '--virtual-time-budget=4000', `--screenshot=${out}/${name}.png`, `${origin}/harness?${query}`], { stdio: 'ignore' });
  chrome.on('exit', code => code === 0 ? done() : fail(Error(`${name}: chrome ${code}`)));
});
try {
  await shot('global-desktop-1280', '1280,2300', 'view=global');
  await shot('global-mobile-390', '390,3600', 'view=global');
  await shot('bot-desktop-1280', '1280,1100', 'view=bot');
  await shot('bot-mobile-390', '390,1300', 'view=bot');
  await shot('bot-off-mobile-390', '390,500', 'view=bot-off');
  console.log(out);
} finally { server.close(); }
