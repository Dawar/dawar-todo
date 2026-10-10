import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

const xml = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const unit = s => `"${String(s).replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('$','$$')}"`;
export function serviceDefinition({ role, platform, executable, releaseDirectory, configPath }) {
  if (!['hub','agent'].includes(role) || !['linux','darwin'].includes(platform)) throw Error('Unsupported service role or platform.');
  const args = [resolve(releaseDirectory,'portable/cli.mjs'),'run',role,'--config',resolve(configPath)];
  const label = `ca.dawar.todo.${role}`;
  if (platform === 'darwin') return { name:`${label}.plist`,contents:`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[executable,...args].map(a=>`<string>${xml(a)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(resolve(releaseDirectory))}</string><key>RunAtLoad</key><false/><key>KeepAlive</key><false/><key>Umask</key><integer>63</integer></dict></plist>\n` };
  return { name:`dawar-portable-${role}.service`,contents:`[Unit]\nDescription=DawarTodo portable ${role}\nAfter=network-online.target\n[Service]\nType=simple\nWorkingDirectory=${unit(resolve(releaseDirectory))}\nExecStart=${[executable,...args].map(unit).join(' ')}\nUMask=0077\nRestart=on-failure\nRestartSec=10\nKillMode=control-group\nTimeoutStopSec=900\n[Install]\nWantedBy=default.target\n` };
}
export async function installDefinitions({ mode, releaseDirectory, configPath, platform=process.platform, home=homedir(), executable=process.execPath }) {
  if (!['hub','agent','both'].includes(mode)) throw Error('Invalid installation mode.');
  const roles=mode==='both'?['hub','agent']:[mode];
  const directory=platform==='linux'?join(home,'.config/systemd/user'):platform==='darwin'?join(home,'Library/LaunchAgents'):null;
  if (!directory) throw Error('Only Linux and macOS are supported.');
  await mkdir(directory,{recursive:true,mode:0o700});
  const paths=[];
  for(const role of roles){const d=serviceDefinition({role,platform,executable,releaseDirectory,configPath});const path=join(directory,d.name);await writeFile(path,d.contents,{mode:0o600,flag:'wx'});paths.push(path);}
  // Installation deliberately does not start or enable an execution service.
  // Exact reviewed cutover owns activation; writing a unit is not migration.
  return paths;
}
