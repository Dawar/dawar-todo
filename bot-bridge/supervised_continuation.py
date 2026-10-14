"""Owner-approved, exact pre-claim continuation of the retained d011 attempt.

The terminal old lease cannot be renewed. A separately approved child lease
must retain the original operation, invocation and immutable failure receipts.
No runtime record is edited; no approval is accepted through CLI or config.
"""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3

from native_queue_receipts import private_file
from supervised_handoff import INSTALLED, INVOCATION

ORIGINAL_OPERATION = 'dwight-supervised-d011-65b12bd-20261009-v1'
ORIGINAL_UNIT = 'dawar-supervised-d011-65b12bd.service'
ORIGINAL_HELPER_INVOCATION = 'f4578849fc3b4451ab3d9cf103fd3266'
ORIGINAL_TARGET = '65b12bdf83d17b419eeb4512d8058e8205318eba'
ORIGINAL_ATTEMPT_SHA = 'f9d9b3c4feb3ec59a753c61c24ca48897752cbc9c8eee9d268fd4e56208952e6'
ORIGINAL_DRAIN_SHA = 'de71b5c551ab85823addebcb59abdb1fff68d5615188b477b67b95d34ae2e987'
ORIGINAL_LEASE_SHA = 'bc595c1d026739b2d791c6d3a5cb133670c2e66a8bbc20aecda5890c4db584b9'
FAILURE_SHA = 'c991f096992166f69d61f9a0d9b3a404ddfe2eeb2e5f4ef2cbaab030521312fb'
CHILD_LEASE = 'dwight-supervised-d011-65b12bd-continuation-20261010-v1'
CHILD_UNIT = 'dawar-supervised-d011-continuation.service'
CONTINUATION_NAME = f'supervised-d011-{INVOCATION}-continuation-v1.json'

# Independently verified direct owner approval of ONE linked child lease.
# This does not waive any active-work, Goal, tool, native or cutover gate.
# The prior msg_01a1207c approval and the migration Goal alone are insufficient.
CONTINUATION_AUTHORITY = {
    'id': 'msg_01a126ed-a6ed-7f13-bab5-4ccef5374e95',
    'offset': 2360619473,
    'rawLineSha256': '8034b6c0cb92e94e2116e020f6ccbd1c49054bd669400e133b84d7a46dff6ef3',
    'textSha256': '4f61c85447fb1b359b29de2ef4262e1e0a96b4f406fd0c43c211248b97c907ba',
    'timestamp': '2026-10-10T17:47:51.405Z',
}


def authority():
    return exact_authority(CONTINUATION_AUTHORITY)


def exact_authority(binding):
    keys = {'id', 'offset', 'rawLineSha256', 'textSha256', 'timestamp'}
    if not isinstance(binding, dict) or set(binding) != keys:
        raise RuntimeError('Supervised continuation is disabled: new exact owner approval is unbound')
    if (not isinstance(binding['id'], str) or not re.fullmatch(r'msg_[a-zA-Z0-9-]+', binding['id']) or
            type(binding['offset']) is not int or binding['offset'] <= 1995843691 or
            any(not isinstance(binding[key], str) or not re.fullmatch(r'[a-f0-9]{64}', binding[key])
                for key in ('rawLineSha256', 'textSha256')) or
            not isinstance(binding['timestamp'], str) or not re.fullmatch(r'2026-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', binding['timestamp'])):
        raise RuntimeError('Exact continuation approval binding is invalid')
    root = Path.home() / '.codex'
    path = root / 'sessions/2026/09/25/rollout-2026-09-25T18-10-12-01a0d9c2-ba00-75d3-ac66-e537c8a1165c.jsonl'
    private_file(path, root)
    with path.open('rb') as file:
        file.seek(binding['offset']); raw = file.readline(1048577)
    if len(raw) > 1048576 or hashlib.sha256(raw).hexdigest() != binding['rawLineSha256']:
        raise RuntimeError('Exact continuation human record unavailable')
    row = json.loads(raw); payload = row.get('payload', {})
    content = payload.get('content')
    if (row.get('type') != 'response_item' or row.get('timestamp') != binding['timestamp'] or
            payload.get('type') != 'message' or payload.get('role') != 'user' or
            payload.get('id') != binding['id'] or not isinstance(content, list) or not content or
            any(not isinstance(item, dict) or item.get('type') != 'input_text' or not isinstance(item.get('text'), str) for item in content)):
        raise RuntimeError('Continuation approval is not the exact native human message')
    text = '\n'.join(item['text'] for item in content)
    if hashlib.sha256(text.encode()).hexdigest() != binding['textSha256']:
        raise RuntimeError('Exact continuation approval text changed')
    return dict(binding)


def read_private(path, root, expected_sha):
    stamp = private_file(path, root)
    if path.stat().st_mode & 0o077 or stamp[2] > 1048576:
        raise RuntimeError('Unsafe or oversized original continuation evidence')
    raw = path.read_bytes()
    if len(raw) > 1048576 or hashlib.sha256(raw).hexdigest() != expected_sha or private_file(path, root) != stamp:
        raise RuntimeError('Original continuation evidence changed')
    return json.loads(raw), {'path': str(path), 'stamp': stamp, 'sha256': expected_sha}


def original_failure(helper):
    base = helper.STATE / 'runtime-updates'
    attempt, attempt_ref = read_private(base / f'supervised-d011-{INVOCATION}.json', helper.STATE, ORIGINAL_ATTEMPT_SHA)
    if any(attempt.get(key) != value for key, value in {
        'installed': INSTALLED, 'invocationId': INVOCATION, 'commit': ORIGINAL_TARGET,
        'operationId': ORIGINAL_OPERATION, 'unitId': ORIGINAL_UNIT, 'waitSeconds': 900, 'mode': 'UNSEALED',
    }.items()):
        raise RuntimeError('Original invocation attempt identity changed')
    drain, drain_ref = read_private(base / ORIGINAL_TARGET / 'drain.json', helper.STATE, ORIGINAL_DRAIN_SHA)
    if any(drain.get(key) != value for key, value in {
        'operationId': ORIGINAL_OPERATION, 'commit': ORIGINAL_TARGET, 'version': '0.161.0',
        'invocationId': INVOCATION, 'unitId': ORIGINAL_UNIT, 'waitSeconds': 900,
    }.items()):
        raise RuntimeError('Original cancelled drain identity changed')
    # lexists also refuses a broken symlink, not only a readable receipt.
    if any(os.path.lexists(base / ORIGINAL_TARGET / name) for name in ('restart.json', 'state-before.sqlite')):
        raise RuntimeError('Original backup/claim/restart exists; continuation is forbidden')
    private_file(helper.STATE / 'state.sqlite', helper.STATE)
    with closing(sqlite3.connect(f'file:{helper.STATE}/state.sqlite?mode=ro', uri=True, timeout=.25)) as db:
        db.execute('PRAGMA query_only=ON')
        rows = db.execute("SELECT CASE WHEN length(CAST(json AS BLOB))<=1048576 THEN json ELSE NULL END FROM records WHERE kind='runtimeMaintenance' AND id=?", (ORIGINAL_OPERATION,)).fetchall()
    if len(rows) != 1 or not rows[0][0] or hashlib.sha256(rows[0][0].encode()).hexdigest() != ORIGINAL_LEASE_SHA:
        raise RuntimeError('Exact terminal original lease changed or is unknown')
    lease = json.loads(rows[0][0])
    if lease.get('phase') != 'cancelled' or any(lease.get(key) != value for key, value in drain.items()):
        raise RuntimeError('Original maintenance lease is not the exact cancelled original')
    # Archived exact journal proof was captured while the unit was fresh. A
    # missing/rotated live journal does not replace the exact archive or unit.
    home = Path.home() / 'bots/dwight-lead-developer-dawartodo'
    failure, failure_ref = read_private(home / 'BOT_CONVERSATIONS_CONFIG_RELEASE_REVIEW_20261009/supervised-65b-failed-before-claim.json', home, FAILURE_SHA)
    if any(failure.get(key) != value for key, value in {
        'commit': ORIGINAL_TARGET, 'helperUnit': ORIGINAL_UNIT, 'helperInvocationId': ORIGINAL_HELPER_INVOCATION,
        'exitCode': 1, 'guardError': 'Original bytes changed during observation',
        'failurePhase': 'waiting snapshot before backup/claim', 'restartReceiptExists': False, 'backupExists': False,
    }.items()):
        raise RuntimeError('Original pre-claim failure evidence is unconfirmed')
    output = helper.command('systemctl', '--user', 'show', ORIGINAL_UNIT,
                            '-p', 'InvocationID', '-p', 'Result', '-p', 'ExecMainCode',
                            '-p', 'ExecMainStatus', '-p', 'ActiveState', '-p', 'SubState')
    unit = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
    if unit != {'InvocationID': ORIGINAL_HELPER_INVOCATION, 'Result': 'exit-code',
                'ExecMainCode': '1', 'ExecMainStatus': '1', 'ActiveState': 'failed', 'SubState': 'failed'}:
        raise RuntimeError('Original helper is not the exact finished pre-claim failure')
    return {'attempt': attempt_ref, 'drain': drain_ref, 'failure': failure_ref,
            'terminalLeaseSha256': ORIGINAL_LEASE_SHA, 'unit': unit}


def helper_identity(helper, unit_id=CHILD_UNIT):
    values = [helper.command('systemctl', '--user', 'show', unit_id, '-p', key, '--value')
              for key in ('MainPID', 'InvocationID', 'ActiveState', 'SubState')]
    if (values[0] != str(os.getpid()) or not re.fullmatch(r'[0-9a-f]{32}', values[1]) or
            values[1] != os.environ.get('INVOCATION_ID') or values[1] in (INVOCATION, ORIGINAL_HELPER_INVOCATION) or
            values[2:] != ['active', 'running']):
        raise RuntimeError('Exact supervised continuation unit/process is unavailable')
    # A competing owner helper is a blocker even if it uses another unit name.
    owned = 0
    for process in Path('/proc').iterdir():
        if not process.name.isdigit() or int(process.name) == os.getpid():
            continue
        try:
            if process.stat().st_uid != os.getuid():
                continue
            owned += 1
            if owned > 4096:
                raise RuntimeError('Owner process inventory exceeds continuation bound')
            with (process / 'cmdline').open('rb') as file:
                raw = file.read(65537)
            if len(raw) > 65536:
                raise RuntimeError('Owner process command exceeds continuation bound')
            if any(Path(arg.decode()).name in ('restart-when-idle.py', 'supervised_handoff.py')
                   for arg in raw.split(b'\0') if arg):
                raise RuntimeError('Another runtime handoff helper exists; no continuation')
        except FileNotFoundError:
            continue  # process exited before it could be observed
    return {'pid': os.getpid(), 'invocationId': values[1], 'unitId': unit_id}


def register(helper, args, approval):
    if args.maintenance_operation != CHILD_LEASE or args.unit_id != CHILD_UNIT or not 60 <= args.wait_seconds <= 900 or args.version != '0.162.1':
        raise RuntimeError('Exact bounded continuation child lease/unit/runtime required')
    # All original proof and approval reads precede the exclusive reservation.
    parent = original_failure(helper); current = helper_identity(helper)
    path = helper.STATE / 'runtime-updates' / CONTINUATION_NAME
    row = {'originalOperationId': ORIGINAL_OPERATION, 'originalInstalledInvocationId': INVOCATION,
           'parentProof': parent, 'continuationLeaseId': CHILD_LEASE, 'unitId': CHILD_UNIT,
           'helperIdentity': current, 'commit': args.commit, 'version': args.version,
           'waitSeconds': args.wait_seconds, 'humanApproval': approval,
           'mode': 'supervised-original-continuation-UNSEALED', 'oneContinuationOnly': True}
    # No overwrite, reopen or retry of this reservation, even before begin.
    with path.open('x') as file:
        os.chmod(path, 0o600)
        json.dump(row, file, indent=2); file.flush(); os.fsync(file.fileno())
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return {'humanApproval': approval, 'attempt': parent['attempt'],
            'continuation': {'path': str(path), 'stamp': private_file(path, helper.STATE),
                             'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'parentProof': parent,
                             'helperIdentity': current}, 'originalOperationId': ORIGINAL_OPERATION,
            'continuationLeaseId': CHILD_LEASE, 'mode': row['mode']}


def check(helper, evidence):
    continuation = evidence['continuation']
    path = helper.STATE / 'runtime-updates' / CONTINUATION_NAME
    if continuation['path'] != str(path) or private_file(path, helper.STATE) != continuation['stamp'] or hashlib.sha256(path.read_bytes()).hexdigest() != continuation['sha256']:
        raise RuntimeError('Exclusive original continuation reservation changed; no restart')
    if authority() != evidence['humanApproval'] or original_failure(helper) != continuation['parentProof'] or helper_identity(helper) != continuation['helperIdentity']:
        raise RuntimeError('Exact continuation authority, parent or helper changed; no restart')
