import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';

// A small user systemd for deploy tests: unit files and drop-ins in a temp
// directory, real child processes (own process group, like a cgroup), the
// properties the deploy adapter reads, --no-block jobs, TimeoutStopSec with
// KillMode=mixed, and an optional activation period during which MainPID is a
// helper outside the release directory (like ExecStartPre).
export class FakeSystemd {
  constructor({ unitDirectory, log, activatingMs = 0 }) {
    Object.assign(this, { unitDirectory, log, activatingMs, units: new Map(), commands: [] });
    this.systemctl = (...args) => this.run(args);
  }
  unit(id) { if (!this.units.has(id)) this.units.set(id, { ActiveState: 'inactive', MainPID: 0, InvocationID: '', Job: '' }); return this.units.get(id); }
  dropIns(id) { const d = join(this.unitDirectory, `${id}.d`); return existsSync(d) ? readdirSync(d).filter(n => n.endsWith('.conf')).sort().map(n => join(d, n)) : []; }
  config(id) {
    const c = { env: {}, exec: null, cwd: '/', timeoutStopSec: 90 };
    for (const file of [join(this.unitDirectory, id), ...this.dropIns(id)]) for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim(), i = line.indexOf('='); if (i < 0 || line.startsWith('[')) continue;
      const key = line.slice(0, i), value = line.slice(i + 1);
      if (key === 'Environment') { const j = value.indexOf('='); c.env[value.slice(0, j)] = value.slice(j + 1); }
      if (key === 'WorkingDirectory') c.cwd = value;
      if (key === 'ExecStart') c.exec = value ? value.split(/\s+/) : null;
      if (key === 'TimeoutStopSec') c.timeoutStopSec = value === 'infinity' ? Infinity : Number(value);
    }
    return c;
  }
  launch(id) {
    const u = this.unit(id), c = this.config(id), invocation = randomUUID().replaceAll('-', '');
    const main = () => {
      const fd = openSync(this.log, 'a');
      const child = spawn(c.exec[0], c.exec.slice(1), { cwd: c.cwd, detached: true, stdio: ['ignore', fd, fd],
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...c.env, INVOCATION_ID: invocation } });
      closeSync(fd);
      Object.assign(u, { ActiveState: 'active', MainPID: child.pid, Job: '', child, config: c });
      child.on('exit', (code, signal) => {
        clearTimeout(u.killTimer);
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
        const clean = code === 0 || u.stopping && signal;
        Object.assign(u, { ActiveState: clean ? 'inactive' : 'failed', MainPID: 0, Job: '', child: null, stopping: false });
        if (u.startAfterStop) { u.startAfterStop = false; this.launch(id); }
      });
    };
    u.InvocationID = invocation;
    if (this.activatingMs) {
      const helper = spawn('sleep', ['30'], { cwd: '/', stdio: 'ignore' });
      Object.assign(u, { ActiveState: 'activating', MainPID: helper.pid, Job: '1' });
      setTimeout(() => { helper.kill('SIGKILL'); main(); }, this.activatingMs);
    } else main();
  }
  stop(id) {
    const u = this.unit(id);
    if (!u.child) return Promise.resolve();
    const exited = new Promise(resolve => u.child.once('exit', resolve));
    if (!u.stopping) {
      Object.assign(u, { ActiveState: 'deactivating', Job: '2', stopping: true });
      u.child.kill('SIGTERM');
      if (Number.isFinite(u.config.timeoutStopSec)) u.killTimer = setTimeout(() => u.child?.kill('SIGKILL'), u.config.timeoutStopSec * 1000);
    }
    return exited;
  }
  async run(args) {
    this.commands.push(args.join(' '));
    const [command, ...rest] = args, id = rest.find(a => a.endsWith('.service')), u = id && this.unit(id), wait = !rest.includes('--no-block');
    if (command === 'show') {
      return [`MainPID=${u.MainPID}`, `InvocationID=${u.InvocationID}`, `ActiveState=${u.ActiveState}`, `SubState=${u.ActiveState === 'active' ? 'running' : 'dead'}`,
        'ControlGroup=', `Job=${u.Job}`, `LoadState=${existsSync(join(this.unitDirectory, id)) ? 'loaded' : 'not-found'}`, `DropInPaths=${this.dropIns(id).join(' ')}`].join('\n') + '\n';
    }
    if (command === 'start') { if (u.child || u.ActiveState === 'activating') return ''; if (u.stopping) { u.startAfterStop = true; return ''; } this.launch(id); return ''; }
    if (command === 'stop') { const done = this.stop(id); if (wait) await done; return ''; }
    if (command === 'restart') { if (u.child) { u.startAfterStop = true; const done = this.stop(id); if (wait) await done; } else this.launch(id); return ''; }
    if (command === 'kill') { u.child?.kill('SIGKILL'); return ''; }
    if (command === 'reset-failed') { if (u.ActiveState === 'failed') u.ActiveState = 'inactive'; return ''; }
    if (['daemon-reload', 'show-environment'].includes(command)) return '';
    throw Error(`fake systemctl: unsupported ${args.join(' ')}`);
  }
  close() { for (const u of this.units.values()) { clearTimeout(u.killTimer); if (u.child) try { process.kill(-u.child.pid, 'SIGKILL'); } catch { /* gone */ } } }
}
