"""ONE Oct11 owner-approved successor, preserving both failed reservations.

The fixed missing-notice correction does not renew an old lease. This uses a
fresh, explicitly approved lease and append-only claim, never an automatic retry.
"""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3

from native_queue_receipts import private_file
from supervised_handoff import INVOCATION
from supervised_continuation import (
    CHILD_LEASE, CHILD_UNIT, CONTINUATION_NAME, exact_authority,
    helper_identity, original_failure, read_private,
)

LEASE = 'dwight-supervised-d011-corrected-cutover-20261011-v1'
UNIT = 'dawar-supervised-d011-corrected.service'
RESERVATION = f'supervised-d011-{INVOCATION}-corrected-cutover-v1.json'
FAILED_TARGET = '02763c0573203bf841d8951437ca64f109132a14'
FAILED_INVOCATION = '70fa008006a54b3bb9d7e1db716dc419'
FAILED_RESERVATION_SHA = '11fedae6a13f563808a8466aa47c9cf54274c5189977f029b9bb7edcbc68058c'
FAILED_DRAIN_SHA = 'ad9c96061b366d346ef517232ffecc74c6cc166099a0c49d0aa375aac221eb32'
FAILED_LEASE_SHA = '0f92e00975a36a3cbfbd65f29e6ff689856246b7c74fa16b326961ce61a7a3a4'
FAILED_OUTCOME_SHA = 'ee0114ef4cd348e10dd16451228fad7baf7dff0d4428ade5afa5732814039931'
APPROVAL = {
    'id': 'msg_01a128be-0da0-7aa0-a416-deed40c03649',
    'offset': 2705305312,
    'rawLineSha256': '10d223b75be9ca68518bab498aed2dbf35c0e55f01d0e8b9cdda28a5522ccc8d',
    'textSha256': '6ecd7ace094a1cf541075864fec2238ed7e960e44b04dee9172562b45fef0433',
    'timestamp': '2026-10-11T02:15:06.400Z',
}


def authority():
    return exact_authority(APPROVAL)


def failed_child(helper):
    original = original_failure(helper)
    base = helper.STATE / 'runtime-updates'
    row, reservation = read_private(base / CONTINUATION_NAME, helper.STATE, FAILED_RESERVATION_SHA)
    if (row.get('continuationLeaseId') != CHILD_LEASE or row.get('unitId') != CHILD_UNIT or
            row.get('commit') != FAILED_TARGET or row.get('parentProof') != original or
            row.get('helperIdentity') != {'pid': 130993, 'invocationId': FAILED_INVOCATION, 'unitId': CHILD_UNIT}):
        raise RuntimeError('Failed child reservation is not the exact linked original')
    drain, drain_ref = read_private(base / FAILED_TARGET / 'drain.json', helper.STATE, FAILED_DRAIN_SHA)
    if drain.get('operationId') != CHILD_LEASE or drain.get('commit') != FAILED_TARGET or drain.get('invocationId') != INVOCATION:
        raise RuntimeError('Failed child drain changed')
    if any(os.path.lexists(base / FAILED_TARGET / name) for name in ('restart.json', 'state-before.sqlite')):
        raise RuntimeError('Failed child has backup/restart evidence; inspect without another cutover')
    private_file(helper.STATE / 'state.sqlite', helper.STATE)
    with closing(sqlite3.connect(f'file:{helper.STATE}/state.sqlite?mode=ro', uri=True, timeout=.25)) as db:
        db.execute('PRAGMA query_only=ON')
        rows = db.execute("SELECT CASE WHEN length(CAST(json AS BLOB))<=1048576 THEN json ELSE NULL END FROM records WHERE kind='runtimeMaintenance' AND id=?", (CHILD_LEASE,)).fetchall()
    if len(rows) != 1 or not rows[0][0] or hashlib.sha256(rows[0][0].encode()).hexdigest() != FAILED_LEASE_SHA:
        raise RuntimeError('Failed child terminal lease changed or is unknown')
    lease = json.loads(rows[0][0])
    if lease.get('phase') != 'cancelled' or any(lease.get(k) != v for k, v in drain.items()):
        raise RuntimeError('Failed child lease is not the exact cancelled original')
    home = Path.home() / 'bots/dwight-lead-developer-dawartodo'
    outcome, outcome_ref = read_private(home / 'migration-evidence-20261011/handover/failed-continuation-actual-outcome.json', home, FAILED_OUTCOME_SHA)
    if any(outcome.get(k) != v for k, v in {
        'source': FAILED_TARGET, 'operationId': CHILD_LEASE, 'helperUnit': CHILD_UNIT,
        'helperInvocationId': FAILED_INVOCATION, 'exitCode': 1,
        'guardError': 'Reviewed retained originals unavailable', 'actualRestartsThisAttempt': 0,
        'backupExists': False, 'restartReceiptExists': False, 'portableLiveStageExists': False,
    }.items()):
        raise RuntimeError('Exact child pre-backup failure is unconfirmed')
    output = helper.command('systemctl', '--user', 'show', CHILD_UNIT, '-p', 'InvocationID', '-p', 'Result',
                            '-p', 'ExecMainCode', '-p', 'ExecMainStatus', '-p', 'ActiveState', '-p', 'SubState')
    unit = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
    if unit != {'InvocationID': FAILED_INVOCATION, 'Result': 'exit-code', 'ExecMainCode': '1',
                'ExecMainStatus': '1', 'ActiveState': 'failed', 'SubState': 'failed'}:
        raise RuntimeError('Failed child unit is not the exact finished failure')
    return {'original': original, 'reservation': reservation, 'drain': drain_ref,
            'leaseSha256': FAILED_LEASE_SHA, 'outcome': outcome_ref, 'unit': unit}


def register(helper, args, approval):
    if (args.maintenance_operation != LEASE or args.unit_id != UNIT or args.version != '0.162.1' or
            not 60 <= args.wait_seconds <= 900 or not args.portable_handoff_configuration):
        raise RuntimeError('Corrected cutover requires its exact lease/unit/runtime and portable configuration')
    parent = failed_child(helper)
    current = helper_identity(helper, UNIT)
    path = helper.STATE / 'runtime-updates' / RESERVATION
    row = {'operationId': LEASE, 'unitId': UNIT, 'commit': args.commit, 'version': args.version,
           'waitSeconds': args.wait_seconds, 'humanApproval': approval, 'parentProof': parent,
           'helperIdentity': current, 'mode': 'owner-approved-corrected-cutover-UNSEALED',
           'oneAttemptOnly': True, 'atMostOneRestart': True}
    with path.open('x') as file:
        os.chmod(path, 0o600)
        json.dump(row, file, indent=2); file.flush(); os.fsync(file.fileno())
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return {'humanApproval': approval, 'attempt': parent['original']['attempt'], 'mode': row['mode'],
            'correctedCutover': {'path': str(path), 'stamp': private_file(path, helper.STATE),
                                'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                                'parentProof': parent, 'helperIdentity': current}}


def check(helper, evidence):
    row = evidence['correctedCutover']
    path = helper.STATE / 'runtime-updates' / RESERVATION
    if (row['path'] != str(path) or private_file(path, helper.STATE) != row['stamp'] or
            hashlib.sha256(path.read_bytes()).hexdigest() != row['sha256'] or
            authority() != evidence['humanApproval'] or failed_child(helper) != row['parentProof'] or
            helper_identity(helper, UNIT) != row['helperIdentity']):
        raise RuntimeError('Corrected cutover authority, parent evidence or exclusive helper changed')
