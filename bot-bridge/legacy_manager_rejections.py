"""Fixed reviewed original refusals; no mutation, retry or success inference."""
import hashlib
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REVIEW = json.loads((ROOT / 'legacy-manager-rejections.json').read_text())
PRODUCER_MATCHES = hashlib.sha256((ROOT / 'manager.mjs').read_bytes()).hexdigest() == REVIEW['managerSourceSha256']
MAX_REJECTIONS = len(REVIEW['records'])


def legacy_manager_rejection(raw, target, bot, evidence=REVIEW, source_matches=PRODUCER_MATCHES):
    try:
        if not source_matches or not isinstance(raw, str) or len(raw.encode()) > 1024 * 1024:
            return None
        row = json.loads(raw)
        known = next((r for r in evidence['records'] if r['id'] == row.get('id')), None)
        guard = known and evidence['guards'][known['operation']]
        if not known or not guard or hashlib.sha256(raw.encode()).hexdigest() != known['recordSha256'] or \
                row.get('state') != 'uncertain' or 'result' in row or row.get('origin') or not bot or \
                bot.get('id') != known['botId'] or bot.get('deletedAt') or \
                any(row.get(k) != known[k] for k in ('id', 'botId', 'name', 'opId', 'fingerprint', 'createdAt', 'finishedAt', 'error')) or \
                row['name'] != guard['name'] or row['error'] != guard['error']:
            return None
        started = datetime.fromisoformat(row['createdAt'].replace('Z', '+00:00'))
        finished = datetime.fromisoformat(row['finishedAt'].replace('Z', '+00:00'))
        if not started.tzinfo or not finished.tzinfo or finished < started:
            return None
        args = row.get('args')
        types = {'string': str, 'boolean': bool}
        if not isinstance(args, dict) or args.get('operation') != known['operation'] or args.get('operationId') != row['opId'] or \
                any(type(value) is not types.get(guard['argumentTypes'].get(key)) for key, value in args.items()) or \
                hashlib.sha256((row['botId'] + ':' + row['opId']).encode()).hexdigest() != row['id'] or \
                hashlib.sha256(json.dumps({'name': row['name'], 'args': args}, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest() != row['fingerprint']:
            return None
        if guard['targetKind'] and (args.get(guard['targetArgument']) != known['targetId'] or not target or
                                    target.get('id') != known['targetId'] or target.get('botId') != row['botId']):
            return None
        if not guard['targetKind'] and 'prompt' in args:
            return None
        return {'id': row['id'], 'botId': row['botId'], 'fingerprint': row['fingerprint'],
                'recordSha256': known['recordSha256'], 'classification': 'reviewed-pre-effect-rejection', 'targetId': known['targetId']}
    except (KeyError, ValueError, TypeError, AttributeError):
        return None


def passive_legacy_manager_rejections(db, bots, rows):
    if len(rows) > MAX_REJECTIONS:
        raise RuntimeError('Legacy rejection metadata exceeds its fixed review bound')
    proofs = []
    for (raw,) in rows:
        row = json.loads(raw)
        known = next((r for r in REVIEW['records'] if r['id'] == row.get('id')), None)
        guard = known and REVIEW['guards'][known['operation']]
        target = None
        if guard and guard['targetKind']:
            found = db.execute("SELECT json_object('id',json_extract(json,'$.id'),'botId',json_extract(json,'$.botId')) FROM records WHERE kind=? AND id=?",
                               (guard['targetKind'], known['targetId'])).fetchone()
            target = found and json.loads(found[0])
        proof = legacy_manager_rejection(raw, target, next((b for b in bots if b['id'] == row.get('botId')), None))
        if not proof:
            raise RuntimeError('Legacy manager operation lacks exact reviewed pre-effect evidence')
        proofs.append(proof)
    return sorted(proofs, key=lambda r: r['id'])
