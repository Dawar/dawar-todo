"""One approved, explicitly UNSEALED first handoff; never a generic bypass.

Ordinary admission uses the installed bounded drain. Existing async answers
remain possible until restart: the human-agreed window controls that race.
No record is rewritten, native input replayed, or installed Seal/Claim invoked.
"""
from contextlib import closing
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import sqlite3
import stat
import time
import urllib.request
from native_queue_receipts import private_file, database_stamp, digest

INSTALLED = 'd0113f9a92f9a3bea29a253bef031f60d1a1d098'
INVOCATION = '7c77d4a4a9074fd294c5eaa1c99dace3'
RECEIPT_SHA = '28636b265a1d4846e1aa8a2b970ada2b4e6957f4503f6cc5b45486436c9b87d2'
CHILD_PID = 2321969
BINARY_SHA = '9a820c17865fa825d04db416818679a9d63bd72e50835c396f496e5684626c9c'
CONNIE = 'peer:432942828b0fda3ba0dc17b009ea1bc7f0ecb5bde9defb74b86b34ae39b98eb2'
DOC = 'async:call_lyPF3QB2taTul9nX7DijB2U5'
LINUS = 'async:call_d097a830dc35437ab45a37c30692bb4e'
# Exact reviewed original, excluding ONLY the recovery scheduling timestamp.
# Every byte, including that timestamp, remains in the current cutover fence.
CONNIE_SHA = '0bdd911fbaf08a23aa3196d10d8a99f1518b40441ea4ab28fe83c9c3157368fa'
DOC_SHA = 'a8f38bb9625ac6aac98c0f0b665c6bf6dd1c7463550bb2cc8bf3b5ff053d14c7'
LINUS_SHA = 'd973f81caaa47f7eb3cb9c189d020213f3ac44bc239b617269c109d8a418c2b7'
COUNT_KEYS = set('admissions requests nativeRpc localActive auxiliaryActive acceptedOrUnknown pendingInput activeGoals calls desktops volatileSecure secureTransfers browserMaintenance bufferedRelay runtimeTick localLocks historyReads browserRetention serviceWork'.split())


def authority():
    # Fixed original native approval, not an arbitrary path/flag or supplied prose.
    root = Path.home() / '.codex'
    path = root / 'sessions/2026/09/25/rollout-2026-09-25T18-10-12-01a0d9c2-ba00-75d3-ac66-e537c8a1165c.jsonl'
    private_file(path, root)
    with path.open('rb') as source:
        source.seek(1995843691)
        line = source.readline(1048577)
    if len(line) > 1048576 or hashlib.sha256(line).hexdigest() != '9a797f2867fd1d5f084ec8256cdf667976132b03c47d4d41ab9952d62b93adbf':
        raise RuntimeError('Exact supervised human authority unavailable')
    return {'id': 'msg_01a1207c-7861-7100-938e-92dce1a7d634', 'rawLineSha256': hashlib.sha256(line).hexdigest()}


def installed_receipt(helper):
    path = helper.STATE / 'runtime-updates' / INSTALLED / 'restart.json'
    private_file(path, helper.STATE)
    raw = path.read_bytes()
    if len(raw) > 65536 or path.stat().st_mode & 0o077 or hashlib.sha256(raw).hexdigest() != RECEIPT_SHA:
        raise RuntimeError('Reviewed installed restart receipt changed')
    row = json.loads(raw)
    if row.get('commit') != INSTALLED or row.get('status') != 'healthy' or row.get('version') != '0.161.0' or row.get('pid') != '2321938':
        raise RuntimeError('Exact installed source/process is unconfirmed')
    return row


def private_paths(helper, receipt_dir):
    for path in (helper.STATE, helper.STATE / 'runtime-updates', receipt_dir):
        s = path.lstat()
        if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077:
            raise RuntimeError('Unsafe supervised receipt directory')
    private_file(helper.STATE / 'state.sqlite', helper.STATE)


def register_attempt(helper, args, approval):
    # Exclusive for this installed invocation, not merely this target commit.
    # A different source/operation cannot evade an unknown earlier handoff.
    path = helper.STATE / 'runtime-updates' / f'supervised-d011-{INVOCATION}.json'
    row = {'installed': INSTALLED, 'invocationId': INVOCATION, 'commit': args.commit,
           'operationId': args.maintenance_operation, 'unitId': args.unit_id,
           'waitSeconds': args.wait_seconds, 'authority': approval, 'mode': 'UNSEALED'}
    with path.open('x') as file:
        os.chmod(path, 0o600)
        json.dump(row, file, indent=2); file.flush(); os.fsync(file.fileno())
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return {'humanApproval': approval, 'attempt': {'path': str(path), 'stamp': private_file(path, helper.STATE), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}}


def check_attempt(helper, evidence):
    attempt = evidence['attempt']
    expected = helper.STATE / 'runtime-updates' / f'supervised-d011-{INVOCATION}.json'
    if attempt['path'] != str(expected) or private_file(expected, helper.STATE) != attempt['stamp'] or hashlib.sha256(expected.read_bytes()).hexdigest() != attempt['sha256']:
        raise RuntimeError('Exclusive original invocation attempt changed; no restart')


def process_identity(helper):
    values = [helper.command('systemctl', '--user', 'show', helper.SERVICE, '-p', f, '--value') for f in ('MainPID', 'InvocationID')]
    if values != ['2321938', INVOCATION]:
        raise RuntimeError('Original installed service identity changed')
    service_path = str(helper.ROOT / 'bot-bridge/service.mjs')
    argv = (Path('/proc') / values[0] / 'cmdline').read_bytes().split(b'\0')
    unit = helper.command('systemctl', '--user', 'show', helper.SERVICE, '-p', 'ExecStart', '-p', 'KillMode', '--value')
    if len(argv) < 2 or argv[1].decode() != service_path or service_path not in unit or 'control-group' not in unit:
        raise RuntimeError('Reviewed source is not the original systemd service path/unit')
    result = []
    for pid in (int(values[0]), CHILD_PID):
        p = Path('/proc') / str(pid)
        if p.stat().st_uid != os.getuid():
            raise RuntimeError('Original process ownership changed')
        fields = (p / 'stat').read_text().rsplit(')', 1)[1].split()
        if pid == CHILD_PID and fields[1] != values[0]:
            raise RuntimeError('Original native child parent changed')
        result.append([pid, fields[19], str((p / 'exe').resolve(strict=True))])
    return [values, result, hashlib.sha256(unit.encode()).hexdigest()]


def exact_originals(helper):
    # Query-only, fixed IDs, finite rows/bytes. All unknown/new rows also remain
    # strict blockers in local_state and in the independently sampled RAM counts.
    private_file(helper.STATE / 'state.sqlite', helper.STATE)
    with closing(sqlite3.connect(f'file:{helper.STATE}/state.sqlite?mode=ro', uri=True, timeout=.25)) as db:
        db.execute('PRAGMA query_only=ON')
        rows = db.execute("SELECT kind,id,CASE WHEN length(CAST(json AS BLOB))<=1048576 THEN json ELSE NULL END FROM records WHERE (kind='primaryInbox' AND id=?) OR (kind='pending' AND id IN (?,?))", (CONNIE, DOC, LINUS)).fetchall()
    if len(rows) != 3 or any(not r[2] for r in rows):
        raise RuntimeError('Reviewed retained originals unavailable')
    for kind, ident, raw in rows:
        row = json.loads(raw)
        if row.get('id') != ident:
            raise RuntimeError('Original record identity changed')
        if kind == 'primaryInbox':
            row.pop('reconcileAfter', None)
            encoded = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
            if hashlib.sha256(encoded).hexdigest() != CONNIE_SHA:
                raise RuntimeError('Reviewed Connie original input/receipt changed')
        elif hashlib.sha256(raw.encode()).hexdigest() != {DOC: DOC_SHA, LINUS: LINUS_SHA}.get(ident):
            raise RuntimeError('Reviewed terminal notice changed')
    return digest(rows)


def fresh_native(proof):
    root = Path.home() / '.codex'
    names = ('thread_history_1.sqlite', 'queue_1.sqlite', 'goals_1.sqlite', 'state_5.sqlite')
    return (proof.get('databaseStamps') == [database_stamp(root / n, root) for n in names] and
            all(private_file(Path(path), root / 'sessions') == stamp for path, stamp in proof.get('rolloutStamps', [])))


def lease_status(helper, drain, deadline):
    left = deadline - time.monotonic()
    if left <= 0:
        raise TimeoutError('Supervised deadline elapsed; no further restart')
    row = helper.owner_maintenance({**drain, 'action': 'status'}, timeout=min(10, left))
    if any(row.get(k) != drain[k] for k in ('operationId', 'commit', 'version', 'instanceId', 'invocationId', 'unitId')) or row.get('phase') != 'draining' or row.get('active') is not True:
        raise RuntimeError('Original draining lease is no longer active')
    remaining = row.get('remainingMs')
    if type(remaining) not in (float, int) or not math.isfinite(remaining) or remaining <= 0:
        raise RuntimeError('Original lease has no bounded remaining time')
    counts = row.get('counts')
    if not isinstance(counts, dict) or set(counts) != COUNT_KEYS or any(type(v) is not int or v < 0 for v in counts.values()):
        raise RuntimeError('Installed RAM/work counter contract is unknown')
    safe = all(v == ({'acceptedOrUnknown': 1, 'pendingInput': 2}.get(k, 0)) for k, v in counts.items())
    return row, safe, time.monotonic()


def snapshot(helper, drain, deadline):
    original = exact_originals(helper)
    observation = {'phase': 'supervised-unsealed', 'native': {'checked': False}}
    bots, busy, fence = helper.local_state(observation, True)
    proof = observation.get('_receiptProof')
    if not busy and (not proof or proof.get('originals') != [] or
                     {r['id'] for r in proof.get('terminalInputs', [])} != {CONNIE} or
                     {r['id'] for r in proof.get('passiveQuestions', [])} != {DOC, LINUS}):
        raise RuntimeError('Supervised proof is not confined to the three exact originals')
    lease, safe, sampled = lease_status(helper, drain, deadline)
    identity = process_identity(helper)
    if exact_originals(helper) != original:
        raise RuntimeError('Original bytes changed during observation')
    if not busy and (time.monotonic() - sampled > 5 or not fresh_native(proof)):
        raise RuntimeError('Current native/RAM proof became stale during observation')
    return bots, busy or not safe, {'local': fence, 'originalBytes': original, 'process': identity, 'expiresAt': lease.get('expiresAt')}, lease, sampled, observation


def source(helper, args):
    if helper.command('git', 'rev-parse', 'HEAD') != args.commit or helper.command('git', 'status', '--porcelain'):
        raise RuntimeError('Reviewed supervised source changed')
    pin = (helper.ROOT / 'bot-bridge/codex-version.mjs').read_text()
    if f'CODEX_VERSION = "{args.version}"' not in pin:
        raise RuntimeError('Reviewed runtime pin changed')


def backup_state(helper, receipt_dir, deadline):
    path = receipt_dir / 'state-before.sqlite'
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    def progress(*_):
        if time.monotonic() >= deadline:
            raise TimeoutError('Private backup exceeded supervised deadline')
    with closing(sqlite3.connect(f'file:{helper.STATE}/state.sqlite?mode=ro', uri=True, timeout=.25)) as db, closing(sqlite3.connect(path)) as backup:
        db.backup(backup, pages=128, progress=progress, sleep=.01)
    with path.open('rb') as file:
        os.fsync(file.fileno())
        sha = hashlib.file_digest(file, 'sha256').hexdigest()
    return {'path': str(path), 'sha256': sha, 'stamp': private_file(path, helper.STATE)}


def activate_supervised(helper, args, receipt_dir, receipt, drain, deadline, evidence):
    # Wait only before backup. Any cutover disagreement aborts, rather than
    # clearing another operation, replacing a proof, or repeatedly restarting.
    check_attempt(helper, evidence)
    while True:
        source(helper, args)
        bots, busy, fence, lease, sampled, observation = snapshot(helper, drain, deadline)
        if not busy and helper.native_idle(bots, observation):
            break
        if deadline - time.monotonic() < 50:
            raise TimeoutError('Current work did not settle within original supervised window')
        time.sleep(min(5, deadline - time.monotonic()))
    source(helper, args)
    backup = backup_state(helper, receipt_dir, deadline)
    bots, busy, after, lease, sampled, observation = snapshot(helper, drain, deadline)
    if busy or after != fence or not helper.native_idle(bots, observation):
        raise RuntimeError('Post-backup current proof changed; no restart')
    # All awaits (including native metadata and source/process reads) precede a
    # final fresh RAM/original/native-store sample. The answer race is UNSEALED.
    source(helper, args)
    bots, busy, final, lease, sampled, observation = snapshot(helper, drain, deadline)
    if busy or final != after or private_file(Path(backup['path']), helper.STATE) != backup['stamp']:
        raise RuntimeError('Final current proof or private backup changed; no restart')
    if min(deadline - time.monotonic(), lease['remainingMs'] / 1000 - (time.monotonic() - sampled)) < 45:
        raise RuntimeError('Original supervised lease leaves no restart window')
    check_attempt(helper, evidence)
    data = {'commit': args.commit, 'version': args.version, 'status': 'claimed', 'claimedAt': time.time(), 'previousPid': '2321938',
            'mode': 'supervised-d011-once-UNSEALED', 'installedSealClaim': False,
            'residualRace': 'Existing async answers remain admitted until restart; human agreed not to answer during cutover.',
            'authority': evidence, 'drain': drain, 'backup': backup, 'currentProof': final,
            'retainedTerminalProof': observation['_receiptProof']}
    with receipt.open('x') as file:
        json.dump(data, file, indent=2); file.flush(); os.fsync(file.fileno())
    directory = os.open(receipt_dir, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    # Fsync/claim creation is also an await boundary. Recheck without changing
    # the original receipt identity; a rejection leaves a non-retryable claim.
    source(helper, args)
    _, busy, claimed_fence, lease, sampled, observation = snapshot(helper, drain, deadline)
    if busy or claimed_fence != final or private_file(Path(backup['path']), helper.STATE) != backup['stamp']:
        raise RuntimeError('Current proof changed after exclusive receipt; no restart')
    if min(deadline - time.monotonic(), lease['remainingMs'] / 1000 - (time.monotonic() - sampled)) < 45:
        raise RuntimeError('Exclusive receipt has no remaining restart window')
    check_attempt(helper, evidence)
    # Same original receipt survives restart/ACK uncertainty. Never call Seal,
    # Claim or a second restart; the next action after failure is inspection.
    helper.subprocess.run(['systemctl', '--user', 'restart', helper.SERVICE], check=True, timeout=min(45, deadline - time.monotonic()))
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen('http://127.0.0.1:47821/healthz', timeout=min(2, deadline - time.monotonic())) as response:
                health = json.load(response)
            pid = helper.command('systemctl', '--user', 'show', helper.SERVICE, '-p', 'MainPID', '--value')
            invocation = helper.command('systemctl', '--user', 'show', helper.SERVICE, '-p', 'InvocationID', '--value')
            metadata = health.get('maintenance', {})
            if health.get('ready') and health.get('relayConnected') and health.get('codexVersion') == args.version and pid.isdigit() and int(pid) > 0 and pid != data['previousPid'] and re.fullmatch('[0-9a-f]{32}', invocation) and invocation != INVOCATION and metadata.get('version') == 1 and metadata.get('phase') == 'open' and metadata.get('invocationId') == invocation and isinstance(metadata.get('instanceId'), str) and metadata['instanceId'] and metadata['instanceId'] != drain['instanceId']:
                data.update(status='healthy', verifiedAt=time.time(), pid=pid, invocationId=invocation)
                receipt.write_text(json.dumps(data, indent=2))
                print(json.dumps({'commit': args.commit, 'version': args.version, 'status': 'healthy', 'mode': data['mode'], 'installedSealClaim': False}))
                return
        except (OSError, ValueError):
            pass
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    raise TimeoutError('Restart attempted; health unconfirmed. Inspect retained original claim')


def run_supervised(helper, args, receipt_dir, receipt):
    deadline = time.monotonic() + min(args.wait_seconds, 900)
    def elapsed(*_):
        raise TimeoutError('Original supervised deadline elapsed; inspect any retained claim')
    prior = signal.signal(signal.SIGALRM, elapsed)
    signal.setitimer(signal.ITIMER_REAL, max(.001, deadline - time.monotonic()))
    drain = None
    try:
        evidence = authority()
        private_paths(helper, receipt_dir)
        installed_receipt(helper)
        identity = process_identity(helper)
        binary = Path(identity[1][1][2])
        with binary.open('rb') as file:
            if hashlib.file_digest(file, 'sha256').hexdigest() != BINARY_SHA:
                raise RuntimeError('Reviewed original native binary changed')
        with urllib.request.urlopen('http://127.0.0.1:47821/healthz', timeout=2) as response:
            health = json.load(response)
        if not health.get('ready') or not health.get('relayConnected') or health.get('codexVersion') != '0.161.0' or health.get('maintenance', {}).get('invocationId') != INVOCATION:
            raise RuntimeError('Healthy exact original bridge is unconfirmed')
        source(helper, args)
        evidence = register_attempt(helper, args, evidence)
        # begin writes its original identity before the HTTP effect; on a lost
        # ACK its existing same-ID status recovery remains the only recovery.
        drain = helper.begin_drain(args, receipt_dir)
        if process_identity(helper) != identity:
            raise RuntimeError('Original process changed during begin')
        activate_supervised(helper, args, receipt_dir, receipt, drain, deadline, evidence)
    finally:
        # Only own unclaimed drain may be cancelled. Unknown/claimed restart
        # stays retained; process loss/cleanup failure relies on original expiry.
        if drain and not receipt.exists() and deadline > time.monotonic():
            try:
                helper.owner_maintenance({**drain, 'action': 'cancel'}, timeout=min(2, deadline - time.monotonic()))
            except (OSError, ValueError, RuntimeError):
                pass
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, prior)
