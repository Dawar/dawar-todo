#!/usr/bin/python3
"""Launch Chrome against this desktop's own persistent user-data directory."""
import os
from pathlib import Path
import sys

if sys.argv[1:2]!=['chrome']:
    raise SystemExit('Usage: codex-desktop-app chrome [Chrome options or URLs]')
config=Path(os.environ.get('XDG_CONFIG_HOME',str(Path.home()/'.config')))
args=sys.argv[2:]
if any(x.startswith(('--user-data-dir','--profile-directory','--app-id')) for x in args):
    raise SystemExit('Desktop launcher owns Chrome profile selection.')
os.execv('/usr/bin/google-chrome-stable',['google-chrome-stable','--user-data-dir='+str(config/'google-chrome'),*args])
