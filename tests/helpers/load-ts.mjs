import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { IDBFactory } from 'fake-indexeddb';
const nativeRequire = createRequire(import.meta.url);
export function runtime(extra = {}, mocks = {}) {
  const indexedDB = new IDBFactory();
  const window = Object.assign(new EventTarget(), { indexedDB, setTimeout, clearTimeout });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const context = { indexedDB, window, document, navigator: { onLine: true }, crypto, Blob, File, Headers, FormData, Response, Request, URL, AbortController, ReadableStream, TextEncoder, TextDecoder, DOMException, Date, Event, setTimeout, clearTimeout, performance, console: { info() {}, warn() {}, error() {} }, ...extra };
  const cache = new Map();
  function load(path) {
    path = resolve(path);
    if (Object.hasOwn(mocks, path)) return mocks[path];
    if (cache.has(path)) return cache.get(path);
    const exports = {};
    cache.set(path, exports);
    const source = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const require = (name) => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (!name.startsWith('.')) return nativeRequire(name);
      let target = resolve(dirname(path), name);
      if (!existsSync(target)) target += existsSync(target + '.ts') ? '.ts' : '.tsx';
      return load(target);
    };
    vm.runInNewContext(source, { ...context, exports, require }, { filename: path });
    return exports;
  }
  return { ...context, load };
}
