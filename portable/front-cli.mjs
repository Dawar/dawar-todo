#!/usr/bin/env node
import { resolve } from 'node:path';
import { readPrivate } from './private-file.mjs';
import { startPublicFront } from './public-front.mjs';

if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('DawarTodo public front requires Node 24.');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config') throw Error('Use --config with the private public-front configuration.');
process.umask(0o077);
const front = startPublicFront(JSON.parse(readPrivate(resolve(args[1]), 16384)));
front.server.on('error', () => { console.error('Public front could not start. Inspect its service configuration.'); void front.close().finally(()=>{process.exitCode=1;}); });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void front.close().then(() => { process.exitCode = 0; }); });
