"""Read-only first-bootstrap evidence, never a queue mutation or replay.

Only retained, positively acknowledged queue.dispatch originals can qualify.
Native SQLite is a private implementation detail: unknown schema, incomplete
projection, changed files and missing/ambiguous evidence all stop the helper.
"""
from contextlib import ExitStack, closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import time

MAX_ORIGINALS = 8
MAX_RECORD_BYTES = 1024 * 1024


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def private_file(path, root):
    path, root = Path(path), Path(root)
    if not path.is_absolute() or '..' in path.parts or not path.is_relative_to(root) or path == root:
        raise RuntimeError('Native metadata path is outside its fixed private root')
    for part in [root, *reversed(path.parents[:len(path.parents) - len(root.parents) - 1]), path]:
        s = part.lstat()
        if stat.S_ISLNK(s.st_mode) or s.st_uid != os.getuid():
            raise RuntimeError('Unsafe native metadata ownership or symlink')
    s = path.stat()
    if not stat.S_ISREG(s.st_mode):
        raise RuntimeError('Native metadata is not a regular file')
    return [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns]


def database_stamp(path, root):
    stamps = [private_file(path, root)]
    wal = Path(str(path) + '-wal')
    try:
        stamps.append(private_file(wal, root))
    except FileNotFoundError:
        stamps.append(None)
    return stamps


def bounded_database(stack, path, deadline):
    db = stack.enter_context(closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=0.25)))
    db.execute('PRAGMA query_only=ON')
    db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
    db.execute('BEGIN')
    return db


def completed_queue_receipts(app, bots, rows, native_root=None, accepted=None, questions=None):
    """Returns private identity/freshness proof; caller still proves current idle.

    native_root is internal dependency injection for disposable observations;
    no tool/CLI accepts a caller-supplied path. No content or credential leaves
    this function. Each query has the common six-second progress deadline.
    """
    root = Path(native_root) if native_root is not None else Path.home() / '.codex'
    accepted, questions = accepted or [], questions or []
    if not 0 <= len(rows) + len(accepted) + len(questions) <= MAX_ORIGINALS:
        raise RuntimeError('Completed native queue receipt bound exceeded')
    paths = [root / name for name in ('thread_history_1.sqlite', 'queue_1.sqlite', 'goals_1.sqlite', 'state_5.sqlite')]
    before = [database_stamp(path, root) for path in paths]
    deadline = time.monotonic() + 6
    bot_map = {bot['id']: bot for bot in bots}
    originals, terminal_inputs, passive_questions, rollouts = [], [], [], []
    with ExitStack() as stack:
        history, queue, goals, state = [bounded_database(stack, path, deadline) for path in paths]
        if queue.execute('SELECT EXISTS(SELECT 1 FROM queued_items)').fetchone()[0]:
            raise RuntimeError('Current accepted native queue blocks bootstrap')
        if goals.execute("SELECT EXISTS(SELECT 1 FROM thread_goals WHERE status='active')").fetchone()[0]:
            raise RuntimeError('Current active native Goal blocks bootstrap')
        if goals.execute("SELECT EXISTS(SELECT 1 FROM thread_goals WHERE status IS NULL OR status NOT IN "
                         "('active','paused','blocked','usage_limited','budget_limited','complete'))").fetchone()[0]:
            raise RuntimeError('Unknown native Goal metadata blocks bootstrap')

        def scope(bot_id, thread_id):
            bot = bot_map.get(bot_id)
            if not bot or bot.get('threadId') != thread_id or bot.get('deletedAt') or bot.get('archiving') or bot.get('archived'):
                raise RuntimeError('Retained native scope is unconfirmed')
            return bot

        def terminal_metadata(thread_id, turns, expected_turn=None, completed_only=False):
            if len(turns) != 1:
                raise RuntimeError('Exact original native terminal evidence is missing or ambiguous')
            turn, status, started, completed, end = turns[0]
            if status not in (('completed',) if completed_only else ('completed', 'failed', 'interrupted')) or \
                    type(started) is not int or type(completed) is not int or completed < started or \
                    completed > time.time() + 2 or type(end) is not int or end <= 0 or expected_turn not in (None, turn):
                raise RuntimeError('Original native execution is not confirmed terminal')
            if history.execute("SELECT EXISTS(SELECT 1 FROM thread_turns WHERE thread_id=? AND "
                               "(status NOT IN ('completed','failed','interrupted') OR status IS NULL))", (thread_id,)).fetchone()[0]:
                raise RuntimeError('Unsettled indexed native execution blocks bootstrap')
            projected = history.execute('SELECT next_rollout_byte_offset FROM thread_history_projection_state WHERE thread_id=?', (thread_id,)).fetchone()
            location = state.execute('SELECT rollout_path FROM threads WHERE id=?', (thread_id,)).fetchone()
            if not projected or not location:
                raise RuntimeError('Native projection freshness is unavailable')
            rollout = Path(location[0])
            stamp = private_file(rollout, root / 'sessions')
            if type(projected[0]) is not int or projected[0] != stamp[2] or end > projected[0]:
                raise RuntimeError('Native projection is stale or incomplete')
            rollouts.append((rollout, stamp))
            return {'turnId': turn, 'status': status, 'completedAt': completed, 'projectedBytes': projected[0]}

        def original_turns(thread_id, client):
            return history.execute("SELECT t.turn_id,t.status,t.started_at,t.completed_at,t.rollout_end_byte_offset "
                "FROM thread_turns t JOIN thread_items i ON i.thread_id=t.thread_id AND i.turn_id=t.turn_id "
                "AND i.item_id=t.first_user_item_id WHERE t.thread_id=? AND i.item_type='userMessage' "
                "AND json_extract(i.item_json,'$.clientId')=? LIMIT 2", (thread_id, client)).fetchall()

        for row in rows:
            bot = scope(row.get('botId'), row.get('threadId'))
            revision = row.get('revision')
            if not bot or bot.get('threadId') != row.get('threadId') or bot.get('deletedAt') or bot.get('archiving') or bot.get('archived') or \
                    row.get('state') != 'native-queued' or type(revision) is not int or revision < 1 or row.get('listId'):
                raise RuntimeError('Retained queue scope or revision is unconfirmed')
            client = 'queue-start:' + hashlib.sha256(f"{bot['id']}:{row['id']}:{revision}".encode()).hexdigest()
            if row.get('operationId') != client or row.get('clientUserMessageId') != client or not isinstance(row.get('nativeQueueId'), str):
                raise RuntimeError('Retained queue original identity conflicts')
            stored = app.execute('SELECT fingerprint,status,json FROM operations WHERE id=?', (client,)).fetchone()
            if not stored or stored[1] != 'done' or len(stored[2].encode()) > MAX_RECORD_BYTES:
                raise RuntimeError('Native queue acknowledgement is missing or uncertain')
            operation = json.loads(stored[2])
            receipt = operation.get('result', {}).get('queuedSubmission', {})
            fingerprint = {'botId': bot['id'], 'id': row['id'], 'revision': revision, 'input': row.get('input')}
            if row.get('source', {}).get('kind') == 'todo':
                fingerprint['taskSource'] = row['source']
            if stored[0] != digest(fingerprint) or operation.get('method') != 'queue.dispatch' or operation.get('botId') != bot['id'] or \
                    operation.get('queueId') != row['id'] or operation.get('revision') != revision or operation.get('clientId') != client or \
                    receipt.get('id') != row['nativeQueueId'] or receipt.get('clientUserMessageId') != client:
                raise RuntimeError('Native queue receipt binding conflicts')
            # A queued start must be the first canonical user item of one turn.
            # Project only indexed identity columns; never transfer item bodies.
            terminal = terminal_metadata(row['threadId'], original_turns(row['threadId'], client), row.get('turnId'), True)
            originals.append({'queueId': row['id'], 'botId': bot['id'], 'threadId': row['threadId'],
                              'revision': revision, 'clientId': client, 'nativeQueueId': row['nativeQueueId'],
                              **terminal})
        for row in accepted:
            scope(row.get('botId'), row.get('threadId'))
            if row.get('state') != 'accepted' or not isinstance(row.get('id'), str) or not row.get('id') or not row.get('turnId'):
                raise RuntimeError('Accepted intake lacks its exact original native binding')
            terminal = terminal_metadata(row['threadId'], original_turns(row['threadId'], row['id']), row['turnId'])
            # Terminal is execution evidence, never task completion or release
            # of an interrupted/held input. Its local receipt stays unchanged.
            terminal_inputs.append({'id': row['id'], 'botId': row['botId'], 'threadId': row['threadId'], **terminal})
        for row in questions:
            request = row.get('request', {})
            params = request.get('params', {})
            scope(row.get('botId'), params.get('threadId'))
            if row.get('async') is not True or params.get('isBlocking') is not False or request.get('method') != 'item/tool/requestUserInput' or \
                    row.get('id') != request.get('id') or row.get('id') != 'async:' + str(params.get('itemId')):
                raise RuntimeError('Pending native question is not a durable nonblocking notification')
            turns = history.execute("SELECT t.turn_id,t.status,t.started_at,t.completed_at,t.rollout_end_byte_offset "
                "FROM thread_turns t JOIN thread_items i ON i.thread_id=t.thread_id AND i.turn_id=t.turn_id "
                "WHERE t.thread_id=? AND t.turn_id=? AND i.item_id=? AND i.item_type='agentMessage' "
                "AND json_array_length(json_extract(i.item_json,'$.questions'))>0 LIMIT 2",
                (params['threadId'], params.get('turnId'), params['itemId'])).fetchall()
            terminal = terminal_metadata(params['threadId'], turns, params.get('turnId'))
            passive_questions.append({'id': row['id'], 'botId': row['botId'], 'threadId': params['threadId'], **terminal})
        if time.monotonic() >= deadline or before != [database_stamp(path, root) for path in paths] or \
                any(private_file(path, root / 'sessions') != stamp for path, stamp in rollouts):
            raise RuntimeError('Native receipt observation changed or exceeded its bound')
    return {'originals': sorted(originals, key=lambda row: row['queueId']), 'databaseStamps': before,
            'terminalInputs': sorted(terminal_inputs, key=lambda row: row['id']),
            'passiveQuestions': sorted(passive_questions, key=lambda row: row['id']),
            'rolloutStamps': sorted((str(path), stamp) for path, stamp in rollouts)}
