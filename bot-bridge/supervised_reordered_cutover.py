"""Exact owner-approved cutover after completing all deployment commands.

All three failed attempts remain immutable. This module admits one new lease
for the October11 instruction, and never renews or retries a failed lease.
"""
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3

from native_queue_receipts import private_file
from supervised_continuation import exact_authority, helper_identity, read_private
import supervised_corrected_cutover as previous

LEASE = 'dwight-supervised-d011-reordered-cutover-20261011-v1'
UNIT = 'dawar-supervised-d011-reordered.service'
RESERVATION = f'supervised-d011-{previous.INVOCATION}-reordered-cutover-v1.json'
TARGET = 'f088c5a1543897e181af5bad4e8cb4f9e5a92183'
INVOCATION = '39bb4d3d1c774d5aab3c0ca2b06bdb12'
RESERVATION_SHA = '9f301508d6ed77330b4561a61c25dde97ae51f239c0f3f7f3178740f9bde0aeb'
DRAIN_SHA = '907586e4340931adab7b0a42b9c77cf85081b850455e0e2218ac2f014404b514'
LEASE_SHA = '5eba0004de0c4f4e2f9fe47979425039041b6514dca7d48369c7da8f493d25b3'
OUTCOME_SHA = '69f0388824085a5048e978382fb051881a57e8e1094c62d52363415902bf1453'
APPROVAL = {'id': 'msg_01a128cf-b62b-7423-a8e0-9dcef8b49b50', 'timestamp': '2026-10-11T02:34:23.659Z',
            'offset': 2713261101, 'rawLineSha256': 'bb4d943953150cd7c08261a7811868ac6936913db621f78bf51a0218b393cfeb',
            'textSha256': '6797c7fce04d72d72553f09527e7d1af9313bfcdb76e6387f8b45341f3c76433'}


def authority():
    return exact_authority(APPROVAL)


def failed_parent(helper):
    ancestors = previous.failed_child(helper)
    base = helper.STATE / 'runtime-updates'
    row, reservation = read_private(base / previous.RESERVATION, helper.STATE, RESERVATION_SHA)
    if (row.get('parentProof') != ancestors or row.get('operationId') != previous.LEASE or
            row.get('commit') != TARGET or row.get('unitId') != previous.UNIT or
            row.get('helperIdentity') != {'pid': 151051, 'invocationId': INVOCATION, 'unitId': previous.UNIT}):
        raise RuntimeError('Exact corrected attempt parent changed')
    drain, drain_ref = read_private(base / TARGET / 'drain.json', helper.STATE, DRAIN_SHA)
    if any(os.path.lexists(base / TARGET / name) for name in ('restart.json', 'state-before.sqlite')):
        raise RuntimeError('Previous backup or restart exists; inspect instead of proceeding')
    private_file(helper.STATE / 'state.sqlite', helper.STATE)
    with closing(sqlite3.connect(f'file:{helper.STATE}/state.sqlite?mode=ro', uri=True, timeout=.25)) as db:
        db.execute('PRAGMA query_only=ON')
        rows = db.execute("SELECT CASE WHEN length(CAST(json AS BLOB))<=1048576 THEN json ELSE NULL END FROM records WHERE kind='runtimeMaintenance' AND id=?", (previous.LEASE,)).fetchall()
    if len(rows) != 1 or not rows[0][0] or hashlib.sha256(rows[0][0].encode()).hexdigest() != LEASE_SHA:
        raise RuntimeError('Exact cancelled corrected lease changed')
    lease = json.loads(rows[0][0])
    if lease.get('phase') != 'cancelled' or any(lease.get(k) != v for k, v in drain.items()):
        raise RuntimeError('Corrected parent lease is not cancelled')
    home = Path.home() / 'bots/dwight-lead-developer-dawartodo'
    outcome, outcome_ref = read_private(home / 'migration-evidence-20261011/handover/corrected-failed-actual-outcome.json', home, OUTCOME_SHA)
    if any(outcome.get(k) != v for k, v in {
        'source': TARGET, 'operationId': previous.LEASE, 'unit': previous.UNIT, 'invocationId': INVOCATION,
        'exitCode': 1, 'guardError': 'Reviewed supervised source changed', 'actualRestarts': 0,
        'backupExists': False, 'restartReceiptExists': False, 'liveStageExists': False, 'unitDropinExists': False,
    }.items()):
        raise RuntimeError('Exact corrected pre-backup failure is unconfirmed')
    raw = helper.command('systemctl', '--user', 'show', previous.UNIT, '-p', 'InvocationID', '-p', 'Result',
                         '-p', 'ExecMainCode', '-p', 'ExecMainStatus', '-p', 'ActiveState', '-p', 'SubState')
    unit = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
    if unit != {'InvocationID': INVOCATION, 'Result': 'exit-code', 'ExecMainCode': '1',
                'ExecMainStatus': '1', 'ActiveState': 'failed', 'SubState': 'failed'}:
        raise RuntimeError('Corrected parent helper is not the exact finished failure')
    return {'ancestors': ancestors, 'reservation': reservation, 'drain': drain_ref,
            'leaseSha256': LEASE_SHA, 'outcome': outcome_ref, 'unit': unit}


def register(helper, args, approval):
    if (args.maintenance_operation != LEASE or args.unit_id != UNIT or args.version != '0.162.1' or
            not 60 <= args.wait_seconds <= 900 or not args.portable_handoff_configuration):
        raise RuntimeError('Reordered cutover requires the approved exact lease/unit/runtime/configuration')
    parent = failed_parent(helper)
    current = helper_identity(helper, UNIT)
    path = helper.STATE / 'runtime-updates' / RESERVATION
    row = {'operationId': LEASE, 'unitId': UNIT, 'commit': args.commit, 'version': args.version,
           'waitSeconds': args.wait_seconds, 'humanApproval': approval, 'parentProof': parent,
           'helperIdentity': current, 'mode': 'owner-approved-reordered-cutover-UNSEALED',
           'oneAttemptOnly': True, 'atMostOneRestart': True}
    with path.open('x') as file:
        os.chmod(path, 0o600)
        json.dump(row, file, indent=2); file.flush(); os.fsync(file.fileno())
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return {'humanApproval': approval, 'attempt': parent['ancestors']['original']['attempt'], 'mode': row['mode'],
            'reorderedCutover': {'path': str(path), 'stamp': private_file(path, helper.STATE),
                                'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                                'parentProof': parent, 'helperIdentity': current}}


def check(helper, evidence):
    row = evidence['reorderedCutover']; path = helper.STATE / 'runtime-updates' / RESERVATION
    if (row['path'] != str(path) or private_file(path, helper.STATE) != row['stamp'] or
            hashlib.sha256(path.read_bytes()).hexdigest() != row['sha256'] or
            authority() != evidence['humanApproval'] or failed_parent(helper) != row['parentProof'] or
            helper_identity(helper, UNIT) != row['helperIdentity']):
        raise RuntimeError('Reordered cutover authority, parent or exclusive helper changed')
