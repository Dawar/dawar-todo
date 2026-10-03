#!/usr/bin/env python3
"""One receipt per reviewed commit; restart only after current work is idle.

Uses the existing private local manager credential for read-only native status.
Never runs messages, rewrites work records, or retries a claimed restart.
"""
import argparse
import http.client
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
STATE = Path.home() / '.local/share/dawar-todo-bots'
SERVICE = 'dawar-todo-bots.service'


def command(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def local_state():
    with sqlite3.connect(f'file:{STATE}/state.sqlite?mode=ro', uri=True) as db:
        bots = [json.loads(r[0]) for r in db.execute('SELECT json FROM bots')]
        rows = [json.loads(r[0]) for r in db.execute(
            "SELECT json FROM records WHERE kind IN ('runLane','managerWorker')")]
        active = [r for r in bots + rows if r.get('activeTurnId') or r.get('status') == 'running']
        # Pending native submissions are current work even before turn-start.
        pending = db.execute("SELECT COUNT(*) FROM records WHERE "
            "(kind IN ('primaryInbox','burstBatch','messageBurst') AND json_extract(json,'$.state') IN ('dispatching','uncertain')) "
            "OR (kind='promptQueue' AND json_extract(json,'$.state') IN ('dispatching','native-queued'))").fetchone()[0]
        fence = sorted((r['id'], r.get('activeTurnId'), r.get('status')) for r in bots)
        return bots, bool(active or pending), fence


def manager_connection():
    adapter = str(ROOT / 'bot-bridge/manager-mcp.mjs')
    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        try:
            if process.stat().st_uid != os.getuid():
                continue
            args = (process / 'cmdline').read_bytes().split(b'\0')
            if len(args) < 4 or args[1].decode() != adapter:
                continue
            sock, bot = args[2].decode(), args[3].decode()
            if sock != str(STATE / 'manager/manager.sock'):
                continue
            env = dict(part.split(b'=', 1) for part in (process / 'environ').read_bytes().split(b'\0') if b'=' in part)
            token = env.get(b'DAWAR_MANAGER_TOKEN', b'').decode()
            if len(token) == 64 and all(c in '0123456789abcdef' for c in token):
                return sock, bot, token
        except (OSError, UnicodeError):
            continue
    raise RuntimeError('Local native status credential is unavailable')


def native_idle(bots):
    sock, bot, token = manager_connection()
    statuses = {}
    for archived in (False, True):
        cursor = None
        seen = set()
        for _ in range(10):
            connection = http.client.HTTPConnection('localhost', timeout=10)
            connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.sock.settimeout(10)
            connection.sock.connect(sock)
            try:
                connection.request('POST', '/tools/call', json.dumps({'botId': bot, 'name': 'codex_threads',
                    'args': {'operation': 'list', 'archived': archived, 'limit': 100, 'cursor': cursor}}),
                    {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
                response = connection.getresponse()
                raw = response.read(8 * 1024 * 1024 + 1)
                if response.status != 200 or len(raw) > 8 * 1024 * 1024:
                    raise RuntimeError('Incomplete native status response')
                page = json.loads(raw).get('result', {})
                if not isinstance(page.get('data'), list) or 'nextCursor' not in page:
                    raise RuntimeError('Invalid native status response')
                for thread in page['data']:
                    statuses[thread['id']] = thread.get('status', {}).get('type')
                cursor = page['nextCursor']
                if cursor is None:
                    break
                if not isinstance(cursor, str) or cursor in seen:
                    raise RuntimeError('Invalid native status cursor')
                seen.add(cursor)
            finally:
                connection.close()
        else:
            raise RuntimeError('Native status pagination exceeded bound')
    if any(status not in ('idle', 'notLoaded') for status in statuses.values()):
        return False
    # Native list omits empty, never-written threads. Read that exact identity
    # with a small byte bound rather than inferring idle from the omission.
    missing = [b for b in bots if b.get('threadId') and not b.get('archived') and b['threadId'] not in statuses]
    if len(missing) > 4:
        raise RuntimeError('Too many omitted primary threads to establish idle')
    for target in missing:
        connection = http.client.HTTPConnection('localhost', timeout=10)
        connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        connection.sock.settimeout(10)
        connection.sock.connect(sock)
        try:
            connection.request('POST', '/tools/call', json.dumps({'botId': bot, 'name': 'codex_threads',
                'args': {'operation': 'read', 'threadId': target['threadId']}}),
                {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
            response = connection.getresponse()
            raw = response.read(65537)
            if response.status != 200 or len(raw) > 65536:
                raise RuntimeError('Omitted primary thread requires an explicit bounded read')
            result = json.loads(raw).get('result', {})
            thread = result.get('thread', {})
            if thread.get('id') != target['threadId'] or thread.get('turns') != [] or result.get('data') != [] or result.get('nextCursor') is not None:
                raise RuntimeError('Omitted primary is not confirmed empty')
            statuses[target['threadId']] = thread.get('status', {}).get('type')
        finally:
            connection.close()
    return all(not b.get('threadId') or b.get('archived') or statuses.get(b['threadId']) in ('idle', 'notLoaded') for b in bots)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--commit', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--wait-seconds', type=int, default=900)
    args = parser.parse_args()
    receipt_dir = STATE / 'runtime-updates' / args.commit
    receipt_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    receipt = receipt_dir / 'restart.json'
    if receipt.exists():
        raise RuntimeError('Restart receipt already exists; inspect it rather than repeat')
    deadline = time.monotonic() + min(max(args.wait_seconds, 0), 3600)
    while True:
        if command('git', 'rev-parse', 'HEAD') != args.commit or command('git', 'status', '--porcelain'):
            raise RuntimeError('Reviewed source changed')
        bots, busy, fence = local_state()
        if not busy and native_idle(bots):
            # Back up while the service is still healthy, then recheck current
            # activity immediately before the one exclusive restart claim.
            with sqlite3.connect(f'file:{STATE}/state.sqlite?mode=ro', uri=True) as source:
                with sqlite3.connect(receipt_dir / 'state-before.sqlite') as backup:
                    source.backup(backup)
            _, busy, after = local_state()
            if not busy and after == fence and native_idle(bots):
                break
        if time.monotonic() >= deadline:
            raise RuntimeError('Active work did not settle; no restart performed')
        time.sleep(5)
    previous_pid = command('systemctl', '--user', 'show', SERVICE, '-p', 'MainPID', '--value')
    data = {'commit': args.commit, 'version': args.version, 'status': 'claimed', 'claimedAt': time.time(), 'previousPid': previous_pid}
    with receipt.open('x') as file:
        json.dump(data, file, indent=2)
        file.flush()
        os.fsync(file.fileno())
    subprocess.run(['systemctl', '--user', 'restart', SERVICE], check=True, timeout=45)
    for _ in range(60):
        try:
            with urllib.request.urlopen('http://127.0.0.1:47821/healthz', timeout=2) as response:
                health = json.load(response)
            pid = command('systemctl', '--user', 'show', SERVICE, '-p', 'MainPID', '--value')
            if health.get('ready') and health.get('relayConnected') and health.get('codexVersion') == args.version and pid != previous_pid:
                data.update(status='healthy', verifiedAt=time.time(), pid=pid, models=health.get('models', []))
                receipt.write_text(json.dumps(data, indent=2))
                print(json.dumps(data))
                return
        except (OSError, ValueError):
            pass
        time.sleep(1)
    data.update(status='verification-failed', checkedAt=time.time())
    receipt.write_text(json.dumps(data, indent=2))
    raise RuntimeError('Restart was attempted; new runtime health not confirmed. Inspect before any retry')


if __name__ == '__main__':
    os.umask(0o077)
    main()
