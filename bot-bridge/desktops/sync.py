#!/usr/bin/python3
"""One-way primary XFCE layout synchronization for managed bot profiles."""
import argparse
import configparser
import ctypes
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import select
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET
from gi.repository import Gio, GLib

HOME = Path('/home/dawar')
BASE = HOME / '.local/share/codex-bot-desktops'
STATE = HOME / '.local/share/codex-desktop-sync'
CONFIG = HOME / '.config'
PRIMARY = ':10.0'
CHANNELS = ('xfce4-panel', 'xfce4-desktop', 'xsettings')
THEME = {'/Net/ThemeName', '/Net/IconThemeName', '/Gtk/FontName', '/Gtk/MonospaceFontName',
         '/Gtk/CursorThemeName', '/Gtk/CursorThemeSize', '/Gtk/DecorationLayout'}
APP_URLS = {
    'epecmicnbeignbahjnjgcfjdgnbaagik': 'https://work.dawar.ca/',
    'hnpfjngllnobngcgfapefoaidbinmjnm': 'https://web.whatsapp.com/',
    'kbdhpemeclgiggljbfcmlnmibnmolaih': 'https://dash.cloudflare.com/',
    'pommaclcbfghclhalboakcipcmmndhcj': 'https://chat.google.com/',
}


def run(args, env=None, check=True):
    return subprocess.run(args, env=env, capture_output=True, text=True, timeout=12, check=check)


def write(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(prefix='.sync-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(temp, mode)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp): os.unlink(temp)


def dump(path, value):
    write(path, json.dumps(value, sort_keys=True, indent=2).encode())


def sessions():
    result = {}
    for p in Path('/proc').iterdir():
        try:
            if not p.name.isdigit() or p.stat().st_uid != os.getuid() or (p/'comm').read_text().strip() != 'xfce4-session': continue
            values = dict(v.split('=', 1) for v in (p/'environ').read_bytes().decode().split('\0') if '=' in v)
            if values.get('DBUS_SESSION_BUS_ADDRESS'):
                result[values.get('DISPLAY')] = values
        except (OSError, UnicodeError): pass
    return result


class Settings:
    def __init__(self, address):
        self.connection = Gio.DBusConnection.new_for_address_sync(address,
            Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)

    def call(self, method, arguments):
        return self.connection.call_sync('org.xfce.Xfconf', '/org/xfce/Xfconf', 'org.xfce.Xfconf',
            method, arguments, None, Gio.DBusCallFlags.NONE, 5000, None)

    def get(self, channel):
        values = self.call('GetAllProperties', GLib.Variant('(ss)', (channel, '/'))).get_child_value(0)
        result = {}
        for n in range(values.n_children()):
            pair = values.get_child_value(n)
            value = pair.get_child_value(1).get_variant()
            result[pair.get_child_value(0).unpack()] = {'type': value.get_type_string(), 'value': value.print_(True)}
        return result

    def set(self, channel, properties, replace=False):
        if replace:
            self.call('ResetProperty', GLib.Variant('(ssb)', (channel, '/', True)))
        for name, spec in sorted(properties.items(), key=lambda pair: pair[0].count('/')):
            variant = GLib.Variant.parse(GLib.VariantType.new(spec['type']), spec['value'], None, None)
            self.call('SetProperty', GLib.Variant('(ssv)', (channel, name, variant)))


def from_xml(path):
    result = {}
    if not path.exists(): return result
    def visit(node, prefix):
        for prop in node.findall('property'):
            key = prefix + '/' + prop.get('name')
            kind = prop.get('type')
            types = {'string': 's', 'bool': 'b', 'int': 'i', 'uint': 'u', 'int64': 'x', 'uint64': 't', 'double': 'd'}
            def scalar(n):
                k, v = n.get('type'), n.get('value')
                return GLib.Variant(types[k], v if k=='string' else v=='true' if k=='bool' else float(v) if k=='double' else int(v))
            if kind == 'array':
                value = GLib.Variant('av', [scalar(v) for v in prop.findall('value')])
                result[key] = {'type': value.get_type_string(), 'value': value.print_(True)}
            elif kind in types:
                value = scalar(prop)
                result[key] = {'type': value.get_type_string(), 'value': value.print_(True)}
            visit(prop, key)
    visit(ET.parse(path).getroot(), '')
    return result


def xml_channel(channel, properties):
    root = ET.Element('channel', name=channel, version='1.0')
    nodes = {'': root}
    inverse = {'s':'string', 'b':'bool', 'i':'int', 'u':'uint', 'x':'int64', 't':'uint64', 'd':'double'}
    def scalar_attrs(v):
        kind = v.get_type_string()
        raw = v.unpack()
        return dict(type=inverse[kind], value=('true' if raw else 'false') if kind=='b' else str(raw))
    for path, spec in sorted(properties.items(), key=lambda item:(item[0].count('/'),item[0])):
        prefix = ''
        for part in path.strip('/').split('/'):
            key = prefix + '/' + part
            if key not in nodes: nodes[key] = ET.SubElement(nodes[prefix], 'property', name=part, type='empty')
            prefix = key
        node = nodes[path]
        v = GLib.Variant.parse(GLib.VariantType.new(spec['type']), spec['value'], None, None)
        if v.get_type_string() in inverse:
            node.attrib.update(scalar_attrs(v))
        else:
            node.set('type', 'array')
            for n in range(v.n_children()):
                child = v.get_child_value(n)
                if child.get_type_string()=='v': child=child.get_variant()
                ET.SubElement(node, 'value', **scalar_attrs(child))
    ET.indent(root)
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def launcher(raw, app_urls, icon_map):
    ini = configparser.ConfigParser(interpolation=None, strict=False)
    ini.optionxform = str
    ini.read_string(raw)
    for section in ini.sections():
        if ini.has_option(section, 'Exec'):
            args = shlex.split(ini.get(section, 'Exec'))
            if args and ('chrome' in Path(args[0]).name):
                app_id = next((x.split('=',1)[1] for x in args if x.startswith('--app-id=')), None)
                launch_url = next((x.split('=',1)[1] for x in args if x.startswith('--app-launch-url-for-shortcuts-menu-item=')), None)
                filtered = [x for x in args[1:] if not x.startswith(('--profile-directory=', '--user-data-dir=', '--app-id=', '--app-launch-url-for-shortcuts-menu-item='))]
                if app_id:
                    target = launch_url or app_urls.get(app_id)
                    if not target: raise RuntimeError('A Chrome web app needs a URL mapping: '+app_id)
                    filtered = [x for x in filtered if not x.startswith('--app=')] + ['--app='+target]
                # .desktop Exec quoting is not shell quoting. Escape double quotes/backslashes and retain %U.
                quote = lambda s: '"'+s.replace('\\','\\\\').replace('"','\\"')+'"' if any(c.isspace() or c in '\\"' for c in s) else s
                ini.set(section, 'Exec', ' '.join(map(quote, ['/home/dawar/.local/bin/codex-desktop-app','chrome',*filtered])))
                if section=='Desktop Entry': ini.remove_option(section, 'StartupWMClass')
        if ini.has_option(section, 'Icon'):
            original=ini.get(section,'Icon')
            if original in icon_map: ini.set(section,'Icon',icon_map[original])
    out = io.StringIO();ini.write(out, space_around_delimiters=False)
    return out.getvalue().encode()


def snapshot():
    live=sessions().get(PRIMARY)
    settings=Settings(live['DBUS_SESSION_BUS_ADDRESS']) if live else None
    channels={c: settings.get(c) if settings else from_xml(CONFIG/'xfce4/xfconf/xfce-perchannel-xml'/f'{c}.xml') for c in CHANNELS}
    if '/panels' not in channels['xfce4-panel']:
        raise RuntimeError('Primary panel settings are unavailable; no target layout will be changed.')
    channels['xsettings']={k:v for k,v in channels['xsettings'].items() if k in THEME}
    channels['xfce4-panel']={k:v for k,v in channels['xfce4-panel'].items() if not k.endswith(('/known-items','/known-legacy-items','/hidden-items','/hidden-legacy-items'))}
    app_urls=dict(APP_URLS)
    extra=STATE/'app-urls.json'
    if extra.exists():app_urls.update(json.loads(extra.read_text()))
    icons={}
    for icon in (HOME/'.local/share/icons').rglob('*'):
        if icon.is_file() and icon.suffix in ('.png','.svg','.xpm'):icons.setdefault(icon.stem,str(icon))
    files={}
    for source, target, pattern in [(CONFIG/'xfce4/panel','config/xfce4/panel','*.desktop'),
                                    (HOME/'Desktop','Desktop','*.desktop'),
                                    (HOME/'.local/share/applications','data/applications','*.desktop')]:
        if source.exists():
            paths=source.rglob(pattern) if 'panel' in target else source.glob(pattern)
            for p in paths:
                if p.is_file() and p.stat().st_size < 1_000_000:
                    files[target+'/'+str(p.relative_to(source))]=launcher(p.read_text(),app_urls,icons).decode()
    result={'version':1,'primary_display':PRIMARY,'channels':channels,'files':files}
    result['digest']=hashlib.sha256(json.dumps(result,sort_keys=True).encode()).hexdigest()
    dump(STATE/'template.json',result)
    return result


def monitor_name(env):
    result=run(['/usr/bin/xrandr','--query'],env,False)
    found=re.findall(r'^(\S+) connected',result.stdout,re.M)
    return found[0] if found else 'VNC-0'


def target_path(dest, name):
    relative=Path(name)
    if relative.is_absolute() or '..' in relative.parts or not name.endswith('.desktop') or not name.startswith(('Desktop/','config/xfce4/panel/','data/applications/')):
        raise RuntimeError('Invalid path in layout manifest.')
    path=dest/relative
    if path.is_symlink() or not path.resolve().is_relative_to(dest.resolve()):
        raise RuntimeError('Layout target resolves outside its managed profile.')
    return path


def apply(profile, template, offline=False):
    dest=BASE/profile
    if dest.is_symlink() or not re.fullmatch(r'[a-z][a-z0-9-]{0,39}',profile):raise RuntimeError('Invalid managed profile.')
    cfg=json.loads((dest/'config.json').read_text())
    if cfg['display']<20:raise RuntimeError('Sync refuses human displays.')
    marker=dest/'layout-sync.json'
    old=json.loads(marker.read_text()) if marker.exists() else {}
    if old.get('digest')==template['digest']:return dict(profile=profile,status='unchanged')
    live=sessions().get(f":{cfg['display']}") or sessions().get(f":{cfg['display']}.0")
    if offline and live:raise RuntimeError('Offline sync refuses a live desktop.')
    with (dest/'action.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return dict(profile=profile,status='deferred',reason='desktop action in progress')
        control=dest/'control.json'
        if control.exists() and json.loads(control.read_text()).get('expiresAt',0)>time.time()*1000:
            return dict(profile=profile,status='deferred',reason='exclusive human control')
        env=dict(os.environ,**{k:v for k,v in (live or {}).items() if k in ('DISPLAY','DBUS_SESSION_BUS_ADDRESS','XAUTHORITY','XDG_RUNTIME_DIR')})
        env.update(DISPLAY=f":{cfg['display']}",XAUTHORITY=str(dest/'Xauthority'),XDG_CONFIG_HOME=str(dest/'config'),XDG_DATA_HOME=str(dest/'data'),XDG_CACHE_HOME=str(dest/'cache'))
        settings=Settings(live['DBUS_SESSION_BUS_ADDRESS']) if live else None
        channels=json.loads(json.dumps(template['channels']))
        monitor=monitor_name(env) if live else 'VNC-0'
        channels['xfce4-desktop']={re.sub(r'/monitor[^/]+/',f'/monitor{monitor}/',k):v for k,v in channels['xfce4-desktop'].items()}
        backup=dest/'layout-backups'/str(time.time_ns())
        backup.mkdir(parents=True,mode=0o700)
        previous={c:settings.get(c) if settings else from_xml(dest/'config/xfce4/xfconf/xfce-perchannel-xml'/f'{c}.xml') for c in CHANNELS}
        previous_panel={k:v for k,v in previous['xfce4-panel'].items() if not k.endswith(('/known-items','/known-legacy-items','/hidden-items','/hidden-legacy-items'))}
        panel_changed=previous_panel!=channels['xfce4-panel'] or any(name.startswith('config/xfce4/panel/') and (not (dest/name).exists() or (dest/name).read_text()!=contents) for name,contents in template['files'].items())
        dump(backup/'channels.json',previous)
        if marker.exists():shutil.copy2(marker,backup/'layout-sync.json')
        targets=set(template['files'])|set(old.get('files',[]))
        existed=[]
        for name in targets:
            p=target_path(dest,name)
            if p.exists():
                q=backup/'files'/name;q.parent.mkdir(parents=True,exist_ok=True,mode=0o700);shutil.copy2(p,q);existed.append(name)
        dump(backup/'files.json',{'targets':sorted(targets),'existed':existed})
        panel_stopped=False
        try:
            for name,contents in template['files'].items():
                p=target_path(dest,name)
                if not p.exists() or p.read_text()!=contents:
                    write(p,contents.encode(),0o755 if name.startswith('Desktop/') else 0o600)
            for name in set(old.get('files',[]))-set(template['files']):
                target_path(dest,name).unlink(missing_ok=True)
            if settings:
                if panel_changed:
                    run(['/usr/bin/xfce4-panel','--quit'],env)
                    panel_stopped=True
                    # Only panel process exits; Xvnc/XFCE session and application processes remain.
                    time.sleep(0.35)
                    settings.set('xfce4-panel',channels['xfce4-panel'],True)
                if previous['xfce4-desktop']!=channels['xfce4-desktop']:
                    settings.set('xfce4-desktop',channels['xfce4-desktop'],True)
                settings.set('xsettings',{k:v for k,v in channels['xsettings'].items() if previous['xsettings'].get(k)!=v})
            else:
                for c,props in channels.items():
                    if c=='xsettings':props={**previous[c],**props}
                    write(dest/'config/xfce4/xfconf/xfce-perchannel-xml'/f'{c}.xml',xml_channel(c,props))
            # Persist a manifest before restarting the panel, so retries are deterministic.
            dump(marker,{'digest':template['digest'],'files':sorted(template['files']),'synced_at':time.time(),'backup':str(backup)})
        except Exception:
            for name in targets:
                p=target_path(dest,name);q=backup/'files'/name
                if q.exists():write(p,q.read_bytes(),q.stat().st_mode&0o777)
                else:p.unlink(missing_ok=True)
            if settings:
                for c,props in previous.items():settings.set(c,props,True)
            raise
        finally:
            if panel_stopped:
                # The replacement panel belongs to a separate user unit, not the
                # watcher/agent cgroup, and stops with its desktop's lifecycle.
                command=['systemd-run','--user','--quiet','--collect',
                    '--unit=bot-layout-panel-'+profile+'-'+str(time.time_ns()),
                    '--property=BindsTo=bot-desktop@'+profile+'.service',
                    '--property=After=bot-desktop@'+profile+'.service']
                for k in ('DISPLAY','DBUS_SESSION_BUS_ADDRESS','XAUTHORITY','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_RUNTIME_DIR'):
                    if k in env:command+=['--setenv='+k+'='+env[k]]
                run(command+['/usr/bin/xfce4-panel','--disable-wm-check'])
        return dict(profile=profile,display=cfg['display'],status='synced',shortcuts=sum(p.startswith('Desktop/') for p in template['files']),backup=str(backup),live=bool(live))


def sync(profile=None, offline=False):
    STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (STATE/'sync.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        template=snapshot()
        results=[]
        names=[profile] if profile else [p.parent.name for p in sorted(BASE.glob('*/config.json'))]
        for name in names:
            try:results.append(apply(name,template,offline))
            except Exception as e:results.append(dict(profile=name,status='error',error=type(e).__name__,message=str(e)[:300]))
        result={'source_display':PRIMARY,'digest':template['digest'],'profiles':results}
        dump(STATE/'last-run.json',result)
        return result


def watch():
    """Recursive inotify; debounce changes and retry only deferred/error profiles."""
    libc=ctypes.CDLL(None,use_errno=True)
    fd=libc.inotify_init1(os.O_NONBLOCK|os.O_CLOEXEC)
    if fd<0:raise OSError(ctypes.get_errno(),'inotify_init1')
    roots=[CONFIG/'xfce4/panel',CONFIG/'xfce4/xfconf/xfce-perchannel-xml',HOME/'Desktop',HOME/'.local/share/applications']
    watches={}
    def add():
        for root in roots:
            for p in [root,*root.rglob('*')]:
                if p.is_dir() and str(p) not in watches:
                    wd=libc.inotify_add_watch(fd,os.fsencode(p),0x00000008|0x00000040|0x00000080|0x00000100|0x00000200|0x00000400)
                    if wd>=0:watches[str(p)]=wd
    add();due=time.monotonic()
    try:
        while True:
            timeout=max(0,due-time.monotonic()) if due is not None else None
            readable,_,_=select.select([fd],[],[],timeout)
            if readable:
                data=os.read(fd,1024*1024)
                add()
                due=time.monotonic()+1.5
            if due is not None and time.monotonic()>=due:
                result=sync();print(json.dumps(result),flush=True)
                due=time.monotonic()+30 if any(p['status'] in ('deferred','error') for p in result['profiles']) else None
    finally:os.close(fd)


def main():
    if os.getuid()!=1000 or os.geteuid()!=1000:raise RuntimeError('Run as dawar, never root.')
    os.umask(0o077)
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--profile');p.add_argument('--offline',action='store_true');p.add_argument('--watch',action='store_true')
    args=p.parse_args()
    if args.watch:return watch()
    result=sync(args.profile,args.offline);print(json.dumps(result))
    if any(r['status']=='error' for r in result['profiles']):raise SystemExit(1)


if __name__=='__main__':main()
