#!/usr/bin/python3
"""Launch Chrome against this desktop's own persistent user-data directory."""
import os
import fcntl
import json
import subprocess
import time
from browser import profile, seed_locked, instances
from pathlib import Path
import sys

if sys.argv[1:2]!=['chrome']:
    raise SystemExit('Usage: codex-desktop-app chrome [Chrome options or URLs]')
config=Path(os.environ.get('XDG_CONFIG_HOME',str(Path.home()/'.config')))
args=sys.argv[2:]
if any(x.startswith(('--user-data-dir','--profile-directory','--app-id')) for x in args):
    raise SystemExit('Desktop launcher owns Chrome profile selection.')
command=['/usr/bin/google-chrome-stable','--user-data-dir='+str(config/'google-chrome'),*args]
base=Path.home()/'.local/share/codex-bot-desktops'
p=config.parent
if p.parent.resolve()==base.resolve() and not p.is_symlink():
    cfg=json.loads((p/'config.json').read_text())
    p,cfg=profile(p.name,cfg.get('owner'))
    with (p/'browser-launch.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        seed_locked(p,cfg,config/'google-chrome')
        child=subprocess.Popen(command)
        # Protect offline seeding until Chrome takes ownership; subsequent launches
        # forward into the running instance. Never serialize its whole lifetime.
        for _ in range(100):
            if child.poll() is not None or instances(config/'google-chrome',cfg['display']): break
            time.sleep(0.05)
        else:
            # A startup whose ownership cannot yet be observed keeps the launch
            # lock until it exits; never permit offline writes during uncertainty.
            raise SystemExit(child.wait())
    raise SystemExit(child.wait())
os.execv(command[0],command)
