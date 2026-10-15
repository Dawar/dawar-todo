// Screenshot/inspection harness: real workspace, synthetic transport only.
// Usage: node tests/bot-chapters-browser.mjs <output-dir>
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const out = resolve(process.argv[2] ?? 'outputs/chapters-browser');
await mkdir(out, { recursive: true });
const bundle = await build({ entryPoints: ['tests/fixtures/bot-chapters-browser.jsx'], bundle: true, write: false, outdir: 'outputs/browser-test', format: 'esm', jsx: 'automatic',
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
  await shot('desktop-1440-docked', '1440,900', 'dock&expand');
  await shot('desktop-1024-docked', '1024,768', 'dock&pin');
  await shot('desktop-800-drawer', '800,800', 'drawer');
  await shot('mobile-390-drawer', '390,844', 'drawer');
  await shot('mobile-390-chat', '390,844', 'expand');
  await shot('mobile-320-chat', '320,640', '');
  // AI Elements: native activity, terminal/stack trace, tool, subagent,
  // marker, sources/citations, suggestions, questionnaire and context meter.
  await shot('elements-desktop-1440', '1440,1400', 'elements&dock&expand');
  await shot('elements-mobile-390', '390,1700', 'elements&expand');
  console.log(out);
} finally { server.close(); }
