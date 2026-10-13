import { resolve } from 'node:path';

const quote = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$')}"`;
const directory = value => String(value).replaceAll('\\','\\\\').replaceAll('%','%%');
export function publicFrontService({ executable, releaseDirectory, configPath }) {
  if([executable,releaseDirectory,configPath].some(value=>typeof value!=='string'||/[\n\r\0]/.test(value)))throw Error('Invalid service path.');
  return { name: 'dawar-portable-front.service', contents: `[Unit]\nDescription=DawarTodo persistent public front\nWants=network-online.target\nAfter=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\nWorkingDirectory=${directory(resolve(releaseDirectory))}\nExecStart=${[executable, resolve(releaseDirectory, 'portable/front-cli.mjs'), '--config', resolve(configPath)].map(quote).join(' ')}\nUMask=0077\nRestart=on-failure\nRestartSec=10\nRestartSteps=4\nRestartMaxDelaySec=60\nTimeoutStopSec=25\n\n[Install]\nWantedBy=default.target\n` };
}
