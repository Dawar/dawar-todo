#!/usr/bin/env python3
"""Provision and supervise named, persistent XFCE desktops for the dawar user."""
import argparse
import fcntl
import ipaddress
import shutil
from types import SimpleNamespace
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import subprocess
import sys
import time

BASE = Path(os.environ.get('BOTS_DESKTOP_DIR', str(Path.home() / '.local/share/codex-bot-desktops')))
UNIT_DIR = Path.home() / '.config/systemd/user'
NAME_RE = re.compile(r'[a-z][a-z0-9-]{0,39}\Z')


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def directory(name):
    if not NAME_RE.fullmatch(name):
        raise ValueError('Name must be lowercase ASCII letters, digits or hyphens, starting with a letter.')
    return BASE / name


def config(name):
    return json.loads((directory(name) / 'config.json').read_text())


def service(kind, name, action):
    run(['systemctl', '--user', action, f'bot-{kind}@{name}.service'])


def new_password(dest):
    password = ''.join(secrets.choice('ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789') for _ in range(8))
    text_file = dest / 'rdp-password.new'
    vnc_file = dest / 'vnc-password.new'
    text_file.write_text(password + '\n')
    with vnc_file.open('wb') as out:
        run(['/usr/bin/tigervncpasswd', '-f'], input=(password + '\n').encode(), stdout=out)
    os.replace(text_file, dest / 'rdp-password')
    os.replace(vnc_file, dest / 'vnc-password')


def provision(args):
    name = args.name
    dest = directory(name)
    display, rdp = args.display, args.rdp_port
    vnc = 5900 + display
    if not (20 <= display <= 99 and 1024 <= rdp <= 65535 and 1024 <= vnc <= 65535):
        raise ValueError('Display must be 20..99; RDP port must be 1024..65535.')
    if dest.exists():
        raise ValueError('Desktop already exists. Use start, stop, status or recover.')
    for candidate in BASE.glob('*/config.json'):
        other = json.loads(candidate.read_text())
        if display == other['display'] or rdp == other['rdp_port']:
            raise ValueError(f'Display or RDP port already assigned to {candidate.parent.name}.')
    if Path(f'/tmp/.X11-unix/X{display}').exists():
        raise ValueError(f'X11 display :{display} is already in use.')
    for port in (vnc, rdp):
        try:
            with socket.socket() as sock:
                sock.bind((args.rdp_bind if port == rdp else '127.0.0.1', port))
        except OSError as exc:
            raise ValueError(f'TCP port {port} cannot be reserved: {exc}') from exc
    old_umask = os.umask(0o077)
    try:
        dest.mkdir(parents=True, mode=0o700)
        for sub in ('config', 'cache', 'data'):
            (dest / sub).mkdir(mode=0o700)
        (dest / 'Desktop').mkdir(mode=0o700)
        (dest / 'config' / 'user-dirs.dirs').write_text(f'XDG_DESKTOP_DIR="{dest / "Desktop"}"\n')
        cfg = dict(name=name, owner=getattr(args, 'owner', None), display=display, vnc_port=vnc, rdp_port=rdp,
                   rdp_bind=args.rdp_bind, width=args.width, height=args.height)
        (dest / 'config.json').write_text(json.dumps(cfg, indent=2) + '\n')
        new_password(dest)
        cookie = secrets.token_hex(16)
        run(['/usr/bin/xauth', '-f', str(dest / 'Xauthority')],
            input=f'add :{display} . {cookie}\n', text=True, capture_output=True)
        run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes',
             '-keyout', str(dest / 'rdp-key.pem'), '-out', str(dest / 'rdp-cert.pem'),
             '-days', '365', '-subj', f'/CN=bot-desktop-{name}'], capture_output=True)
        xrdp_ini = f'''[Globals]
ini_version=1
fork=true
port=tcp://{args.rdp_bind}:{rdp}
security_layer=tls
crypt_level=high
ssl_protocols=TLSv1.2,TLSv1.3
certificate={dest / 'rdp-cert.pem'}
key_file={dest / 'rdp-key.pem'}
autorun=bot-{name}
allow_channels=true
bitmap_cache=true
bitmap_compression=true
max_bpp=32

[Logging]
LogFile={dest / 'xrdp.log'}
LogLevel=INFO
EnableSyslog=false

[Channels]
rdpdr=false
rdpsnd=false
drdynvc=false
cliprdr=false
rail=false
xrdpvr=false

[bot-{name}]
name=Bot desktop: {name}
lib=libvnc.so
ip=127.0.0.1
port={vnc}
username=na
password=ask
'''
        (dest / 'xrdp.ini').write_text(xrdp_ini)
        print(f'Provisioned {name}: X11 :{display}, VNC loopback :{vnc}, RDP {args.rdp_bind}:{rdp}.')
        print(f'RDP password stored mode 0600 at {dest / "rdp-password"}; do not put it on a command line.')
    except Exception:
        # A failed initial provision owns only its new private directory.
        shutil.rmtree(dest, ignore_errors=True)
        raise
    finally:
        os.umask(old_umask)


def supervise(name):
    from browser import profile, seed
    cfg = config(name)
    if cfg.get("owner"):
        p, cfg = profile(name, cfg["owner"])
        seed(p, cfg)
    dest = directory(name)
    display = cfg['display']
    env = os.environ.copy()
    for variable in ('DBUS_SESSION_BUS_ADDRESS', 'SESSION_MANAGER', 'DESKTOP_STARTUP_ID'):
        env.pop(variable, None)
    env.update(DISPLAY=f':{display}', XAUTHORITY=str(dest / 'Xauthority'),
               XDG_CONFIG_HOME=str(dest / 'config'), XDG_CACHE_HOME=str(dest / 'cache'),
               XDG_DATA_HOME=str(dest / 'data'), XDG_CURRENT_DESKTOP='XFCE',
               DESKTOP_SESSION='xfce', XDG_SESSION_TYPE='x11',
               XDG_RUNTIME_DIR=f'/run/user/{os.getuid()}')
    xvnc = subprocess.Popen(['/usr/bin/Xvnc', f':{display}', '-geometry',
                             f'{cfg["width"]}x{cfg["height"]}', '-depth', '24',
                             '-rfbport', str(cfg['vnc_port']), '-localhost', 'yes',
                             '-SecurityTypes', 'VncAuth', '-PasswordFile', str(dest / 'vnc-password'),
                             '-auth', str(dest / 'Xauthority'), '-nolisten', 'tcp', '-s', '0',
                             '-AlwaysShared', '1'], env=env, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    xfce = None
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        for _ in range(100):
            if stopping or xvnc.poll() is not None:
                raise RuntimeError('Xvnc stopped during startup.')
            if Path(f'/tmp/.X11-unix/X{display}').exists():
                check = subprocess.run(['/usr/bin/xdpyinfo', '-display', f':{display}'],
                                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if check.returncode == 0:
                    break
            time.sleep(0.1)
        else:
            raise RuntimeError('Xvnc did not open an authenticated X11 display.')
        xfce = subprocess.Popen(['/usr/bin/dbus-run-session', '--', '/usr/bin/xfce4-session'],
                                env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        while not stopping and xvnc.poll() is None and xfce.poll() is None:
            time.sleep(0.5)
        if not stopping:
            raise RuntimeError('Xvnc or XFCE exited; systemd will restart the desktop.')
    finally:
        for child in (xfce, xvnc):
            if child and child.poll() is None:
                child.terminate()
        for child in (xfce, xvnc):
            if child:
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


def health(name, verbose=True):
    cfg = config(name)
    dest = directory(name)
    env = os.environ.copy()
    env.update(DISPLAY=f':{cfg["display"]}', XAUTHORITY=str(dest / 'Xauthority'))
    x_ok = subprocess.run(['/usr/bin/xdpyinfo'], env=env, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL).returncode == 0
    # Observe listeners without failed VNC handshakes (which trigger blacklisting).
    listeners = subprocess.run(['/usr/bin/ss', '-H', '-ltn'], capture_output=True, text=True, check=True).stdout
    ports = {key: any(line.split()[3].rsplit(':', 1)[-1] == str(cfg[key]) for line in listeners.splitlines()) for key in ('vnc_port', 'rdp_port')}
    xfce_ok = False
    for p in Path('/proc').iterdir():
        if p.name.isdecimal():
            try:
                if p.stat().st_uid == os.getuid() and (p / 'comm').read_text().strip() == 'xfce4-session':
                    if f'DISPLAY=:{cfg["display"]}\0'.encode() in (p / 'environ').read_bytes():
                        xfce_ok = True
            except OSError:
                pass
    result = dict(name=name, display=f':{cfg["display"]}', rdp=f'{cfg["rdp_bind"]}:{cfg["rdp_port"]}',
                  x11=x_ok, xfce=xfce_ok, vnc_loopback=ports['vnc_port'], rdp_listener=ports['rdp_port'])
    if verbose:
        print(json.dumps(result))
    return all((x_ok, xfce_ok, *ports.values()))


def managed(args):
    # One interprocess coordinator for allocation and cleanup, including CLI users.
    BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (BASE / 'allocation.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        dest = directory(args.name)
        if args.action == 'ensure' and not dest.exists():
            bind = os.environ.get('BOTS_DESKTOP_RDP_BIND', '127.0.0.1')
            address = ipaddress.ip_address(bind)
            if not address.is_loopback and address not in ipaddress.ip_network('100.64.0.0/10'):
                raise ValueError('Managed RDP bind must be loopback or a Tailscale IPv4 address.')
            used = [json.loads(p.read_text()) for p in BASE.glob('*/config.json')]
            for display in range(20, 100):
                if any(c['display'] == display for c in used) or Path(f'/tmp/.X11-unix/X{display}').exists():
                    continue
                for port in range(3391, 3491):
                    if any(c['rdp_port'] == port for c in used):
                        continue
                    try:
                        with socket.socket() as probe:
                            probe.bind((bind, port))
                        with socket.socket() as probe:
                            probe.bind(('127.0.0.1', 5900 + display))
                    except OSError:
                        continue
                    provision(SimpleNamespace(name=args.name, owner=args.owner, display=display,
                              rdp_port=port, rdp_bind=bind, width=1280, height=800))
                    break
                else:
                    raise ValueError('No free managed RDP ports.')
                break
            else:
                raise ValueError('No free bot displays (20..99). Stop/delete an unused desktop.')
        if not dest.exists() and args.action == 'remove':
            return
        if dest.is_symlink():
            raise ValueError('Managed desktop path must not be a symlink.')
        cfg = config(args.name)
        if args.action == 'adopt':
            if cfg.get('owner') not in (None, args.owner):
                raise ValueError('Desktop is already owned by another bot.')
            cfg['owner'] = args.owner
            atomic(dest / 'config.json', cfg)
            return
        if cfg.get('owner') != args.owner:
            raise ValueError('Desktop ownership does not match this bot.')
        if args.action == 'remove':
            for kind in ('rdp', 'desktop'):
                service(kind, args.name, 'disable')
                service(kind, args.name, 'stop')
            shutil.rmtree(dest)
            return
        if args.action.startswith('lease-'):
            if not args.session or len(args.session) > 180:
                raise ValueError('A control session is required.')
            with (dest / 'action.lock').open('a') as action_lock:
                fcntl.flock(action_lock, fcntl.LOCK_EX)
                lease_path = dest / 'control.json'
                lease = json.loads(lease_path.read_text()) if lease_path.exists() else {}
                live = lease.get('expiresAt', 0) > time.time() * 1000
                if args.action == 'lease-release':
                    if lease.get('session') == args.session:
                        lease_path.unlink(missing_ok=True)
                    return
                if live and lease.get('session') != args.session:
                    raise ValueError('Another browser has desktop control.')
                if args.action == 'lease-renew' and (not live or lease.get('session') != args.session):
                    raise ValueError('Desktop control lease expired.')
                atomic(lease_path, dict(session=args.session, expiresAt=time.time()*1000 + 30000))
            return
        print(json.dumps(cfg))


def atomic(path, value):
    tmp = path.with_suffix('.new')
    with tmp.open('w') as out:
        os.chmod(tmp, 0o600)
        json.dump(value, out)
    os.replace(tmp, path)


def main():
    if os.getuid() == 0 or os.getuid() != os.geteuid():
        raise ValueError('Run as dawar, never root.')
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('provision')
    p.add_argument('name')
    p.add_argument('--display', type=int, required=True)
    p.add_argument('--rdp-port', type=int, required=True)
    p.add_argument('--rdp-bind', choices=('0.0.0.0', '127.0.0.1'), default='0.0.0.0')
    p.add_argument('--width', type=int, default=1280)
    p.add_argument('--height', type=int, default=800)
    for action in ('ensure', 'remove', 'adopt', 'lease-acquire', 'lease-renew', 'lease-release'):
        q = sub.add_parser(action)
        q.add_argument('name')
        q.add_argument('--owner', required=True)
        q.add_argument('--session')
    for action in ('start', 'stop', 'recover', 'status', 'health', 'supervise', 'rotate-password', 'renew-certificate'):
        sub.add_parser(action).add_argument('name')
    args = parser.parse_args()
    if args.action in ('ensure', 'remove', 'adopt', 'lease-acquire', 'lease-renew', 'lease-release'):
        managed(args)
    elif args.action == 'provision':
        BASE.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (BASE / 'allocation.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            provision(args)
    elif args.action == 'supervise':
        supervise(args.name)
    elif args.action == 'health':
        if not health(args.name):
            sys.exit(1)
    elif args.action == 'status':
        for kind in ('desktop', 'rdp'):
            subprocess.run(['systemctl', '--user', 'is-active', f'bot-{kind}@{args.name}.service'], check=False)
        if not health(args.name):
            sys.exit(1)
    elif args.action == 'rotate-password':
        dest = directory(args.name)
        config(args.name)
        old_umask = os.umask(0o077)
        try:
            new_password(dest)
        finally:
            os.umask(old_umask)
        service('desktop', args.name, 'restart')
        service('rdp', args.name, 'restart')
        print(f'Rotated {args.name} RDP password at {dest / "rdp-password"}; active bot RDP sessions were disconnected.')
    elif args.action == 'renew-certificate':
        dest = directory(args.name)
        config(args.name)
        old_umask = os.umask(0o077)
        try:
            run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes',
                 '-keyout', str(dest / 'rdp-key.pem.new'), '-out', str(dest / 'rdp-cert.pem.new'),
                 '-days', '365', '-subj', f'/CN=bot-desktop-{args.name}'], capture_output=True)
            os.replace(dest / 'rdp-key.pem.new', dest / 'rdp-key.pem')
            os.replace(dest / 'rdp-cert.pem.new', dest / 'rdp-cert.pem')
        finally:
            os.umask(old_umask)
        service('rdp', args.name, 'restart')
        print(f'Renewed {args.name} RDP TLS certificate; verify and pin its new fingerprint.')
    else:
        config(args.name)
        if args.action == 'start':
            service('desktop', args.name, 'enable')
            service('desktop', args.name, 'start')
            service('rdp', args.name, 'enable')
            service('rdp', args.name, 'start')
        elif args.action == 'stop':
            service('rdp', args.name, 'disable')
            service('desktop', args.name, 'disable')
            service('rdp', args.name, 'stop')
            service('desktop', args.name, 'stop')
        elif args.action == 'recover':
            service('desktop', args.name, 'restart')
            service('rdp', args.name, 'restart')
        if args.action != 'stop':
            for _ in range(50):
                if health(args.name, verbose=False):
                    break
                time.sleep(0.2)
            else:
                health(args.name)
                sys.exit(1)
            health(args.name)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f'bot-desktop: {exc}', file=sys.stderr)
        sys.exit(1)
