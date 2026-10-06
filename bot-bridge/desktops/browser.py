#!/usr/bin/python3
"""Bot-only browser preferences and guarded graceful close. No credential/tab output."""
import argparse
import ctypes
import ctypes.util
import fcntl
import json
import os
from pathlib import Path
import socket
import shlex
import subprocess
import tempfile
import time

BASE = Path(os.environ.get('BOTS_DESKTOP_DIR', str(Path.home()/'.local/share/codex-bot-desktops')))
HOUR = 3600_000


def atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(prefix='.browser-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(value, out); out.flush(); os.fsync(out.fileno())
        os.chmod(tmp, 0o600); os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def profile(name, owner):
    import re
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', name): raise ValueError('Invalid profile identity.')
    p = BASE/name
    if p.is_symlink() or p.resolve().parent != BASE.resolve(): raise ValueError('Invalid managed profile path.')
    cfg = json.loads((p/'config.json').read_text())
    if not owner or cfg.get('owner') != owner or not 20 <= cfg['display'] <= 99: raise ValueError('Bot profile ownership mismatch.')
    data=p/'config/google-chrome'
    if (p/'config').is_symlink() or data.is_symlink() or data.resolve() != p.resolve()/'config/google-chrome':
        raise ValueError('Browser data path must stay inside the assigned profile.')
    return p, cfg


def instances(data, display):
    roots = []
    for p in Path('/proc').iterdir():
        if not p.name.isdigit(): continue
        try:
            if p.stat().st_uid != os.getuid(): continue
            args = [a for a in (p/'cmdline').read_bytes().decode().split('\0') if a]
            # Chromium rewrites its process title into one space-separated argv
            # entry and can sanitize environ. Parse that title, never infer idle.
            if len(args)==1 and ' ' in args[0]: args=shlex.split(args[0])
            if not args: continue
            if Path(args[0]).name not in ('chrome', 'google-chrome', 'google-chrome-stable'): continue
            if any(a.startswith('--type=') for a in args): continue
            dirs = [a.split('=',1)[1] for a in args if a.startswith('--user-data-dir=')]
            if '--user-data-dir' in args:
                dirs.append(args[args.index('--user-data-dir')+1])
            if not any(Path(d).resolve() == data.resolve() for d in dirs): continue
            env = dict(a.split('=',1) for a in (p/'environ').read_bytes().decode().split('\0') if '=' in a)
            if env.get('DISPLAY') and env['DISPLAY'].split('.')[0] != ':'+str(display): raise ValueError('Browser display ownership is uncertain.')
            stat = (p/'stat').read_text().rsplit(')',1)[1].split()
            roots.append({'pid': int(p.name), 'start': stat[19]})
        except (FileNotFoundError, ProcessLookupError): continue
        except (PermissionError, UnicodeError, IndexError): raise ValueError('Browser ownership cannot be established.')
    return sorted(roots, key=lambda p:p['pid'])


def seed(p, cfg):
    data = p/'config/google-chrome'
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (p/'browser-launch.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return seed_locked(p, cfg, data)


def seed_locked(p, cfg, data):
    # Chrome owns this file while running. Never replace live preferences.
    if instances(data, cfg['display']):
        pref=json.loads((data/'Local State').read_text()).get('performance_tuning',{}).get('high_efficiency_mode',{}) if (data/'Local State').exists() else {}
        return {'memorySaver': 'balanced-live' if pref.get('state')==2 and pref.get('aggressiveness',1)==1 else 'pending-next-launch'}
    singleton = data/'SingletonLock'
    if singleton.is_symlink():
        target = os.readlink(singleton)
        host, _, pid = target.rpartition('-')
        if host != socket.gethostname() or not pid.isdigit(): return {'memorySaver':'pending-uncertain-lock'}
        if Path('/proc',pid).exists(): return {'memorySaver':'pending-live-lock'}
    elif singleton.exists(): return {'memorySaver':'pending-uncertain-lock'}
    path = data/'Local State'
    if path.is_symlink(): raise ValueError('Browser preference ownership is uncertain.')
    value = json.loads(path.read_text()) if path.exists() else {}
    pref = value.setdefault('performance_tuning', {}).setdefault('high_efficiency_mode', {})
    if pref.get('state') != 2 or pref.get('aggressiveness') != 1:
        if path.exists():
            backup = p/'browser-preference-backups'/f'local-state-{time.time_ns()}.json'
            atomic(backup, value)
        pref.update(state=2, aggressiveness=1)
        atomic(path, value)
    return {'memorySaver': 'balanced'}


def idle_ms(display, authority):
    os.environ.update(DISPLAY=f':{display}', XAUTHORITY=str(authority))
    x11 = ctypes.CDLL(ctypes.util.find_library('X11'))
    xss = ctypes.CDLL(ctypes.util.find_library('Xss'))
    class Info(ctypes.Structure):
        _fields_ = [('window',ctypes.c_ulong),('state',ctypes.c_int),('kind',ctypes.c_int),
                    ('til_or_since',ctypes.c_ulong),('idle',ctypes.c_ulong),('event_mask',ctypes.c_ulong)]
    x11.XOpenDisplay.argtypes=[ctypes.c_char_p]; x11.XOpenDisplay.restype=ctypes.c_void_p
    x11.XDefaultRootWindow.argtypes=[ctypes.c_void_p]; x11.XDefaultRootWindow.restype=ctypes.c_ulong
    x11.XCloseDisplay.argtypes=[ctypes.c_void_p]
    xss.XScreenSaverQueryInfo.argtypes=[ctypes.c_void_p,ctypes.c_ulong,ctypes.POINTER(Info)]
    xss.XScreenSaverQueryExtension.argtypes=[ctypes.c_void_p,ctypes.POINTER(ctypes.c_int),ctypes.POINTER(ctypes.c_int)]
    d=x11.XOpenDisplay(f':{display}'.encode())
    if not d: raise ValueError('Desktop input activity is unavailable.')
    try:
        event=ctypes.c_int(); error=ctypes.c_int(); info=Info()
        if not xss.XScreenSaverQueryExtension(d,ctypes.byref(event),ctypes.byref(error)) or not xss.XScreenSaverQueryInfo(d,x11.XDefaultRootWindow(d),ctypes.byref(info)):
            raise ValueError('Desktop idle extension is unavailable.')
        return int(info.idle)
    finally: x11.XCloseDisplay(d)


def connections(cfg):
    result=subprocess.run(['/usr/bin/ss','-Htn','state','established'],capture_output=True,text=True,check=True,timeout=2)
    for line in result.stdout.splitlines():
        fields=line.split()
        if len(fields)<4: raise ValueError('Connection activity is uncertain.')
        # With a state filter ss omits the state column; local endpoint is column 2.
        port=fields[2].rsplit(':',1)[-1]
        if port in (str(cfg['rdp_port']),str(cfg['vnc_port'])): return True
    return False


def probe(p,cfg):
    data=p/'config/google-chrome'
    path=data/'Local State'
    pref=json.loads(path.read_text()).get('performance_tuning',{}).get('high_efficiency_mode',{}) if path.exists() else {}
    return {'instances':instances(data,cfg['display']), 'boot':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
            'memorySaver':'balanced' if pref.get('state')==2 and pref.get('aggressiveness',1)==1 else 'pending-next-launch',
            'idleMs':idle_ms(cfg['display'],p/'Xauthority'), 'monotonicMs':time.monotonic()*1000, 'connected':connections(cfg)}


def lease_active(p):
    path=p/'control.json'
    if not path.exists(): return False
    lease=json.loads(path.read_text())
    if not isinstance(lease.get('session'),str) or not lease['session'] or not isinstance(lease.get('expiresAt'),(float,int)):
        raise ValueError('Exclusive control state is uncertain.')
    import math
    if not math.isfinite(lease['expiresAt']): raise ValueError('Exclusive control state is uncertain.')
    return lease['expiresAt']>time.time()*1000

def close(p,cfg,expected):
    with (p/'action.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        def guard():
            state=probe(p,cfg)
            if state['boot']!=expected['boot'] or state['instances']!=expected['instances'] or not state['instances']:
                raise ValueError('Browser instance changed; release it again after review.')
            if state['monotonicMs']-state['idleMs']>expected['monotonicMs'] or state['idleMs']<HOUR or state['connected'] or lease_active(p):
                raise ValueError('Desktop input, connection or exclusive lease protects this browser.')
            return state
        guard()
        env={**os.environ,'DISPLAY':f':{cfg["display"]}','XAUTHORITY':str(p/'Xauthority')}
        raw=subprocess.run(['/usr/bin/wmctrl','-lp'],env=env,capture_output=True,text=True,check=True,timeout=2).stdout
        pids={p['pid'] for p in expected['instances']}
        windows=[line.split()[0] for line in raw.splitlines() if len(line.split())>=4 and int(line.split()[2]) in pids]
        if len(windows)>8: raise ValueError('Too many browser windows for a bounded close; review manually.')
        if not windows: raise ValueError('No owned browser window; background browser is retained.')
        sent=0
        for window in windows:
            guard() # Recheck under the same input/action lock immediately before each WM_DELETE.
            subprocess.run(['/usr/bin/wmctrl','-ic',window],env=env,capture_output=True,check=True,timeout=2)
            sent+=1
        return {'closeRequested':sent,'verify':'Graceful request only. Refusal or save prompts remain open; no force kill or automatic retry.'}


def reopen(p,cfg):
    with (p/'action.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if lease_active(p): raise ValueError('Human exclusive control is active.')
        env={'DISPLAY':f':{cfg["display"]}','XAUTHORITY':str(p/'Xauthority'),
            'XDG_CONFIG_HOME':str(p/'config'),'XDG_DATA_HOME':str(p/'data'),'XDG_CACHE_HOME':str(p/'cache')}
        # An independent user service keeps Chrome outside the central bridge's
        # cgroup: backend updates must not terminate this persistent browser.
        unit=f'bot-browser-{p.name}-{time.time_ns()}'
        command=['/usr/bin/systemd-run','--user','--quiet','--collect','--unit='+unit,
            '--property=Type=exec','--property=UMask=0077',
            f'--property=BindsTo=bot-desktop@{p.name}.service',
            f'--property=After=bot-desktop@{p.name}.service']
        command += ['--setenv='+k+'='+v for k,v in env.items()]
        command += [str(Path.home()/'.local/bin/codex-desktop-app'),'chrome','--restore-last-session']
        subprocess.run(command,stdin=subprocess.DEVNULL,capture_output=True,check=True,timeout=3)
        return {'launched':True,'verify':'Take a screenshot. Unsaved state is not guaranteed to restore.'}

def main():
    if os.getuid()==0 or os.getuid()!=os.geteuid(): raise ValueError('Run as the desktop user.')
    parser=argparse.ArgumentParser(); parser.add_argument('action',choices=('seed','probe','close','reopen')); parser.add_argument('name');parser.add_argument('--owner',required=True);parser.add_argument('--expected')
    a=parser.parse_args();p,cfg=profile(a.name,a.owner)
    value=seed(p,cfg) if a.action=='seed' else probe(p,cfg) if a.action=='probe' else reopen(p,cfg) if a.action=='reopen' else close(p,cfg,json.loads(a.expected))
    print(json.dumps(value))

if __name__=='__main__':
    os.umask(0o077)
    try: main()
    except Exception as error:
        # No raw subprocess output or paths/URLs from private browser data.
        print(json.dumps({'deferred':True,'reason':str(error) if isinstance(error,ValueError) else type(error).__name__}));raise SystemExit(1)
