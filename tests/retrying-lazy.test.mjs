import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, Suspense } from 'react';
import { prerenderToNodeStream } from 'react-dom/static';
import { runtime } from './helpers/load-ts.mjs';

const { retryingLazy } = runtime().load('lib/retrying-lazy.ts');
async function render(element) {
  const { prelude } = await prerenderToNodeStream(h(Suspense, { fallback: 'loading' }, element), { onError() {} });
  let html = ''; for await (const chunk of prelude) html += chunk; return html;
}

test('a lazy panel whose chunk failed once imports again on the next render', async () => {
  let calls = 0;
  const Panel = retryingLazy(() => (++calls === 1
    ? Promise.reject(new Error('Failed to fetch dynamically imported module'))
    : Promise.resolve({ default: ({ label }) => h('p', null, label) })));
  // The first render fails the import (an error boundary would show "Try again").
  assert.doesNotMatch(await render(h(Panel, { label: 'Run history' })), /Run history/);
  // "Try again" re-renders: plain React.lazy would re-throw the cached failure.
  assert.match(await render(h(Panel, { label: 'Run history' })), /Run history/);
  assert.equal(calls, 2);
  // A loaded panel is not imported again.
  await render(h(Panel, { label: 'again' }));
  assert.equal(calls, 2);
});
