"""Migration hook in the ONE approved linked continuation, never a helper/retry.

Prepare from that helper's new private backup; all original idle proofs are
repeated afterward. Change the unit only after the original exclusive claim.
One systemctl restart then replaces the old service by hub + the same agent.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time


def configuration(helper, args):
    path = Path(args.portable_handoff_configuration)
    if not path.is_absolute() or not re.fullmatch('[a-f0-9]{64}', args.portable_handoff_sha256 or ''):
        raise RuntimeError('Exact private portable handover configuration/hash required')
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077 or s.st_size > 32768:
        raise RuntimeError('Unsafe portable handover configuration')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != args.portable_handoff_sha256:
        raise RuntimeError('Original portable handover configuration changed')
    row = json.loads(raw)
    if row.get('kind') != 'dawar-portable-central-handover' or row.get('source') != args.commit:
        raise RuntimeError('Portable handover belongs to another reviewed source')
    node = Path.home() / '.local/bin/node'
    if not subprocess.check_output([str(node), '--version'], text=True).strip().startswith('v24.'):
        raise RuntimeError('Reviewed Node 24 installation required')
    release = Path(row['releaseDirectory'])
    if not release.is_absolute() or release.resolve() != release:
        raise RuntimeError('Portable release must be a fixed local directory')
    dropin = Path.home() / '.config/systemd/user' / (helper.SERVICE + '.d') / '90-portable-migration.conf'
    if dropin.exists() or dropin.is_symlink():
        raise RuntimeError('Portable unit handover already exists; reconcile without retry')
    return row, node, dropin


def prepare(helper, args, backup, deadline):
    row, node, _ = configuration(helper, args)
    remaining = deadline - time.monotonic() - 45
    if remaining < 1:
        raise RuntimeError('No bounded portable staging window remains')
    # Fixed reviewed module; no shell, caller command, live data overwrite or
    # automatic native launch. Output is paths/hashes, never credentials/bodies.
    result = subprocess.run([str(node), str(helper.ROOT / 'portable/prepare-handover.mjs'),
                             str(args.portable_handoff_configuration), args.portable_handoff_sha256,
                             args.commit, backup['path'], backup['sha256']],
                            check=True, capture_output=True, text=True, timeout=remaining)
    if len(result.stdout) > 16384:
        raise RuntimeError('Portable staging receipt exceeds its bound')
    receipt = json.loads(result.stdout)
    if receipt.get('source') != args.commit or receipt.get('processesStarted') != 0:
        raise RuntimeError('Portable staging source/receipt differs')
    expected = Path(row['stageDirectory']) / 'hub.json'
    if receipt.get('hubConfig') != str(expected):
        raise RuntimeError('Portable staging path differs')
    return receipt


def check_prepared(args, prepared):
    for key, sha_key in [('hubConfig', 'hubConfigSHA256'), ('receipt', 'receiptSHA256')]:
        path = Path(prepared[key])
        s = path.lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077 or \
                hashlib.sha256(path.read_bytes()).hexdigest() != prepared[sha_key]:
            raise RuntimeError('Original portable prepared configuration/receipt changed')
    receipt = json.loads(Path(prepared['receipt']).read_bytes())
    agent = Path(receipt['agentConfig'])
    if agent.is_symlink() or agent.stat().st_mode & 0o077 or \
            hashlib.sha256(agent.read_bytes()).hexdigest() != prepared['agentConfigSHA256']:
        raise RuntimeError('Original agent configuration changed')
    if receipt.get('configurationSHA256') != args.portable_handoff_sha256 or receipt.get('source') != args.commit:
        raise RuntimeError('Original portable staging input/source changed')


def install_after_claim(helper, args, prepared):
    row, node, dropin = configuration(helper, args)
    check_prepared(args, prepared)
    def quote(value):
        return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'
    dropin.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    s = dropin.parent.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077:
        raise RuntimeError('Unsafe original unit drop-in directory')
    working_directory = str(row['releaseDirectory']).replace('\\', '\\\\').replace('%', '%%')
    content = '[Service]\nWorkingDirectory=' + working_directory + '\nExecStart=\nExecStart=' + \
        ' '.join(map(quote, [node, Path(row['releaseDirectory']) / 'portable/cli.mjs', 'run', 'both', '--config', prepared['hubConfig']])) + \
        '\nRestart=no\nUMask=0077\nKillMode=control-group\nTimeoutStopSec=900\n'
    with dropin.open('x') as file:
        os.chmod(dropin, 0o600)
        file.write(content)
        file.flush()
        os.fsync(file.fileno())
    directory = os.open(dropin.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True, timeout=10)
    return {'path': str(dropin), 'sha256': hashlib.sha256(content.encode()).hexdigest()}
