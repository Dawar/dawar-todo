"""Linux-only, fixed-file memory CAS. No payload or arbitrary path tool API.

An atomic exchange retains the displaced file too. If a concurrent edit won
the final hash/rename gap, restore it; if another writer also changed the new
file, retain both and report uncertainty rather than overwrite either.
"""
import ctypes
import hashlib
import json
import os
import re
import stat
import sys


def reject(message):
    raise RuntimeError(message)


def owned(info, directory=False, private=False):
    if info.st_uid != os.getuid() or info.st_mode & 0o022:
        reject('unsafe owner or permissions')
    if directory:
        if not stat.S_ISDIR(info.st_mode):
            reject('not a directory')
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        reject('not a singly linked regular file')
    if private and stat.S_IMODE(info.st_mode) != 0o600:
        reject('candidate is not private')


def version(info):
    return ':'.join(str(v) for v in (info.st_dev, info.st_ino, info.st_uid,
                                    info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns))


def read_at(directory, name, maximum, private=False):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(fd)
        owned(before, private=private)
        if before.st_size > maximum:
            reject('file is oversized')
        checksum = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            size += len(chunk)
            if size > maximum:
                reject('file grew')
            checksum.update(chunk)
        after = os.fstat(fd)
        target = os.stat(name, dir_fd=directory, follow_symlinks=False)
        if version(before) != version(after) or version(before) != version(target):
            reject('file changed during verification')
        return checksum.hexdigest(), after
    finally:
        os.close(fd)


def main():
    spec = json.loads(sys.stdin.buffer.read(8192))
    operation = spec['operationId']
    if not re.fullmatch(r'memory-v1-[a-f0-9]{64}', operation) or not re.fullmatch(r'[a-f0-9]{64}', spec['candidateHash']):
        reject('invalid operation')
    cwd = spec['cwd']
    if not os.path.isabs(cwd) or os.path.realpath(cwd) != cwd:
        reject('workspace is not canonical')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
    root = os.open(cwd, flags)
    parent = op = None
    try:
        info = os.fstat(root)
        owned(info, directory=True)
        if f'{info.st_dev}:{info.st_ino}:{info.st_uid}' != spec['workspaceIdentity']:
            reject('workspace was replaced')
        parent = os.open('.memory-maintenance', flags, dir_fd=root)
        op = os.open(operation, flags, dir_fd=parent)
        for directory in (parent, op):
            owned(os.fstat(directory), directory=True)
            if stat.S_IMODE(os.fstat(directory).st_mode) != 0o700:
                reject('archive directory is not private')
        name = f"commit-{spec['candidateHash']}.md"
        original, before = read_at(root, 'MEMORY.md', 8 * 1024 * 1024)
        candidate, candidate_info = read_at(op, name, 24 * 1024, private=True)
        if original != spec['sourceHash'] or version(before) != spec['sourceIdentity'] or candidate != spec['candidateHash']:
            reject('source or candidate changed before exchange')
        current_root = os.stat(cwd, follow_symlinks=False)
        if (current_root.st_dev, current_root.st_ino) != (info.st_dev, info.st_ino):
            reject('workspace changed before exchange')
        libc = ctypes.CDLL(None, use_errno=True)
        exchange = libc.renameat2
        exchange.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        exchange.restype = ctypes.c_int

        def swap():
            if exchange(root, b'MEMORY.md', op, name.encode(), 2):
                raise OSError(ctypes.get_errno(), 'memory atomic exchange failed')
            os.fsync(root)
            os.fsync(op)

        swap()
        displaced, old = read_at(op, name, 8 * 1024 * 1024)
        if displaced != spec['sourceHash'] or (old.st_dev, old.st_ino) != (before.st_dev, before.st_ino) or old.st_mtime_ns != before.st_mtime_ns:
            installed, new = read_at(root, 'MEMORY.md', 8 * 1024 * 1024)
            if installed == spec['candidateHash'] and (new.st_dev, new.st_ino) == (candidate_info.st_dev, candidate_info.st_ino):
                swap()
                reject('concurrent source edit restored; retain original operation for review')
            reject('concurrent edits retained in both locations; original operation needs inspection')
        installed, _ = read_at(root, 'MEMORY.md', 24 * 1024, private=True)
        if installed != spec['candidateHash']:
            reject('replacement changed; retain both files and reconcile original operation')
        print('{"exchanged":true}')
    finally:
        for descriptor in (op, parent, root):
            if descriptor is not None:
                os.close(descriptor)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never include contents, keys, arguments or traceback in output.
        print(json.dumps({'error': str(error)[:240]}), file=sys.stderr)
        sys.exit(1)
