#!/usr/bin/env python3
"""One receipt per reviewed commit; restart only after current work is idle.

Uses the existing private local manager credential for read-only native status.
Never runs messages, rewrites work records, or retries a claimed restart.
"""
import argparse
import http.client
import json
import os
import re
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
STATE = Path.home() / '.local/share/dawar-todo-bots'
SERVICE = 'dawar-todo-bots.service'


def command(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True, timeout=10).strip()


def local_state(observation=None):
    with sqlite3.connect(f'file:{STATE}/state.sqlite?mode=ro', uri=True) as db:
        bots = [json.loads(r[0]) for r in db.execute('SELECT json FROM bots')]
        rows = [json.loads(r[0]) for r in db.execute(
            "SELECT json FROM records WHERE kind IN ('runLane','managerWorker')")]
        active = [r for r in bots + rows if r.get('activeTurnId') or r.get('status') == 'running']
        # Pending native submissions are current work even before turn-start.
        pending = db.execute("SELECT COUNT(*) FROM records WHERE "
            "(kind IN ('primaryInbox','burstBatch','messageBurst') AND json_extract(json,'$.state') IN ('dispatching','uncertain')) "
            "OR (kind='promptQueue' AND json_extract(json,'$.state') IN ('dispatching','native-queued'))").fetchone()[0]
        if observation is not None:
            observation['local'] = {
                'activeBots': sum(bool(r.get('activeTurnId') or r.get('status') == 'running') for r in bots),
                'activeAux': sum(bool(r.get('activeTurnId') or r.get('status') == 'running') for r in rows),
                'pendingDispatch': pending,
            }
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


def native_idle(bots, observation=None):
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
    def describe_native():
        if observation is not None:
            counts = {status: 0 for status in ('idle', 'notLoaded', 'active', 'systemError', 'unknown')}
            for status in statuses.values():
                counts[status if isinstance(status, str) and status in counts else 'unknown'] += 1
            observation['native'] = {'checked': True, 'observedThreads': len(statuses), 'statuses': counts}

    describe_native()
    if any(status not in ('idle', 'notLoaded') for status in statuses.values()):
        return False
    # Native list omits empty, never-written threads. Read that exact identity
    # with a small byte bound rather than inferring idle from the omission.
    missing = [b for b in bots if b.get('threadId') and not b.get('archived') and b['threadId'] not in statuses]
    if observation is not None:
        observation['native']['omittedPrimaries'] = len(missing)
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
    describe_native()
    if observation is not None:
        observation['native']['omittedPrimaries'] = len(missing)
    return all(not b.get('threadId') or b.get('archived') or statuses.get(b['threadId']) in ('idle', 'notLoaded') for b in bots)


def owner_maintenance(params):
    # Existing private MACHINE credential, never a bot MCP session or forged
    # browser owner. Only the systemd-owned current service is consulted.
    pid = command('systemctl', '--user', 'show', SERVICE, '-p', 'MainPID', '--value')
    process = Path('/proc') / pid
    if not pid.isdigit() or int(pid) < 1 or process.stat().st_uid != os.getuid():
        raise RuntimeError('Owner maintenance service identity unavailable')
    env = dict(part.split(b'=', 1) for part in (process / 'environ').read_bytes().split(b'\0') if b'=' in part)
    token = env.get(b'BOTS_MACHINE_SECRET', b'').decode()
    if len(token) < 32:
        raise RuntimeError('Owner maintenance credential unavailable')
    connection = http.client.HTTPConnection('localhost', timeout=30)
    connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.sock.settimeout(30)
    connection.sock.connect(str(STATE / 'manager/manager.sock'))
    try:
        connection.request('POST', '/runtime/maintenance', json.dumps(params),
                           {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        response = connection.getresponse()
        raw = response.read(65537)
        if response.status != 200 or len(raw) > 65536:
            raise RuntimeError('Owner maintenance blocked; inspect original identity/status (no restart)')
        result = json.loads(raw).get('result')
        if not isinstance(result, dict):
            raise RuntimeError('Invalid maintenance metadata')
        return result
    finally:
        connection.close()


def begin_drain(args, receipt_dir):
    with urllib.request.urlopen('http://127.0.0.1:47821/healthz', timeout=2) as response:
        health = json.load(response)
    metadata = health.get('maintenance', {})
    invocation = command('systemctl', '--user', 'show', SERVICE, '-p', 'InvocationID', '--value')
    if metadata.get('version') != 1 or not metadata.get('instanceId') or metadata.get('invocationId') != invocation:
        raise RuntimeError('Admission drain is not installed; use original strict-idle procedure, never simulate a fence')
    params = {'operationId': args.maintenance_operation, 'commit': args.commit, 'version': args.version,
              'instanceId': metadata['instanceId'], 'invocationId': invocation,
              'unitId': args.unit_id, 'waitSeconds': min(max(args.wait_seconds, 1), 900)}
    # One helper identity. A retained attempt is inspected, not relaunchable.
    with (receipt_dir / 'drain.json').open('x') as file:
        json.dump(params, file, indent=2); file.flush(); os.fsync(file.fileno())
    try:
        result = owner_maintenance({**params, 'action': 'begin'})
    except (OSError, ValueError, RuntimeError):
        # Positive original-ID status can reconcile a lost begin ACK. It never
        # creates another operation or extends the original expiry.
        result = owner_maintenance({**params, 'action': 'status'})
    if result.get('phase') != 'draining':
        raise RuntimeError('Original maintenance lease is not active; inspect it')
    return params


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--commit', required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--wait-seconds', type=int, default=900)
    parser.add_argument('--maintenance-operation')
    parser.add_argument('--unit-id')
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', args.commit) or not re.fullmatch(r'\d+\.\d+\.\d+', args.version):
        raise RuntimeError('Exact reviewed SHA and version are required')
    if bool(args.maintenance_operation) != bool(args.unit_id):
        raise RuntimeError('A maintenance operation and original unit ID are both required')
    receipt_dir = STATE / 'runtime-updates' / args.commit
    receipt_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    receipt = receipt_dir / 'restart.json'
    if receipt.exists():
        raise RuntimeError('Restart receipt already exists; inspect it rather than repeat')
    if command('git', 'rev-parse', 'HEAD') != args.commit or command('git', 'status', '--porcelain'):
        raise RuntimeError('Reviewed source changed')
    drain = begin_drain(args, receipt_dir) if args.maintenance_operation else None
    try:
        activate(args, receipt_dir, receipt, drain)
    finally:
        if drain:
            try:
                owner_maintenance({**drain, 'action': 'cancel'})
            except (OSError, ValueError, RuntimeError):
                # Claimed, disconnected or expired is retained for inspection.
                pass


def activate(args, receipt_dir, receipt, drain):
    deadline = time.monotonic() + min(max(args.wait_seconds, 0), 900 if drain else 3600)
    started = time.monotonic()
    attempts, previous_reason, blocked = 0, None, {}
    while True:
        if command('git', 'rev-parse', 'HEAD') != args.commit or command('git', 'status', '--porcelain'):
            raise RuntimeError('Reviewed source changed')
        attempts += 1
        observation = {'phase': 'before-backup', 'native': {'checked': False}}
        bots, busy, fence = local_state(observation)
        if drain:
            checked = owner_maintenance({**drain, 'action': 'observe'})
            observation['maintenance'] = {key: checked.get(key) for key in ('safe', 'counts', 'native', 'reason')}
            busy = busy or not checked.get('safe')
        reason = 'local-current-work' if busy else 'native-current-work'
        if not busy and native_idle(bots, observation):
            # Back up while the service is still healthy, then recheck current
            # activity immediately before the one exclusive restart claim.
            with sqlite3.connect(f'file:{STATE}/state.sqlite?mode=ro', uri=True) as source:
                with sqlite3.connect(receipt_dir / 'state-before.sqlite') as backup:
                    source.backup(backup)
            observation = {'phase': 'after-backup', 'native': {'checked': False}}
            _, busy, after = local_state(observation)
            reason = 'local-current-work' if busy else 'local-fence-changed' if after != fence else 'native-current-work'
            if not busy and after == fence and native_idle(bots, observation):
                if drain:
                    checked = owner_maintenance({**drain, 'action': 'observe'})
                    observation['maintenance'] = {key: checked.get(key) for key in ('safe', 'counts', 'native', 'reason')}
                    if not checked.get('safe'):
                        busy = True
                    else:
                        sealed = owner_maintenance({**drain, 'action': 'seal'})
                        if sealed.get('phase') != 'sealed':
                            raise RuntimeError('Maintenance could not seal; no restart')
                if not busy:
                    break
        blocked[reason] = blocked.get(reason, 0) + 1
        diagnostic = {'event': 'idle-handoff-wait', 'attempts': attempts,
                      'elapsedSeconds': round(time.monotonic() - started, 1),
                      'reason': reason, 'observation': observation, 'blockedAttempts': blocked}
        if reason != previous_reason:
            print(json.dumps(diagnostic), file=sys.stderr, flush=True)
            previous_reason = reason
        if time.monotonic() >= deadline:
            diagnostic['event'] = 'idle-handoff-timeout'
            print(json.dumps(diagnostic), file=sys.stderr, flush=True)
            raise RuntimeError('Active work did not settle; no restart performed')
        time.sleep(5)
    previous_pid = command('systemctl', '--user', 'show', SERVICE, '-p', 'MainPID', '--value')
    data = {'commit': args.commit, 'version': args.version, 'status': 'claimed', 'claimedAt': time.time(), 'previousPid': previous_pid}
    with receipt.open('x') as file:
        json.dump(data, file, indent=2)
        file.flush()
        os.fsync(file.fileno())
    if drain:
        claimed = owner_maintenance({**drain, 'action': 'claim'})
        acknowledged_at = time.monotonic()
        if claimed.get('phase') != 'claimed' or not isinstance(claimed.get('remainingMs'), (int, float)):
            raise RuntimeError('Maintenance claim failed; no restart')
        if command('systemctl', '--user', 'show', SERVICE, '-p', 'InvocationID', '--value') != drain['invocationId']:
            raise RuntimeError('Original service changed; inspect retained claim, no restart')
        if claimed['remainingMs'] - (time.monotonic() - acknowledged_at) * 1000 < 45_000:
            raise RuntimeError('Original lease leaves no restart handoff window; inspect retained claim')
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
