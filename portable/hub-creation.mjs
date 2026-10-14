import { CREATION_OPERATION, fingerprint, id, originalCreationProof } from './protocol.mjs';

// Owner bot creation on an execution node. The hub reserves the new bot's
// identity (= the original operation ID), its placement and a provisional
// record together with the mailbox command, then completes the record only
// from the node's creation proof. It never resubmits an unconfirmed create.

const now = () => new Date().toISOString();
const PARAMS = new Set(['name', 'purpose', 'provider', 'nodeId']);
// Fields a created native bot contributes to the hub record once.
const IDENTITY = ['name', 'purpose', 'cwd', 'color', 'threadId', 'model', 'effort', 'serviceTier', 'mode', 'executionMode',
  'provider', 'avatar', 'burstQuietSeconds', 'status', 'preview', 'updatedAt', 'error'];
const fail = (message, outcome) => Object.assign(Error(message), { outcome });

export function creationParams(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !PARAMS.has(key)))
    throw fail('Bot creation accepts only a name, purpose, provider and machine.', 'rejected');
  const name = typeof params.name === 'string' ? params.name.trim() : '';
  if (!name || name.length > 80) throw fail('Give the bot a name of at most 80 characters.', 'rejected');
  if (params.purpose !== undefined && (typeof params.purpose !== 'string' || params.purpose.length > 2000))
    throw fail('The purpose must be text of at most 2000 characters.', 'rejected');
  if (params.provider !== undefined && !['codex', 'claude'].includes(params.provider)) throw fail('Unknown bot provider.', 'rejected');
  if (params.nodeId !== undefined && !id(params.nodeId)) throw fail('Unknown execution machine.', 'rejected');
  // The node command carries only what native creation accepts.
  return { name, purpose: params.purpose ?? '', ...(params.provider === 'claude' ? { provider: 'claude' } : {}) };
}

export class HubCreation {
  constructor(controls) { this.controls = controls; }
  get store() { return this.controls.store; }

  /** Connected, unrevoked nodes of this owner whose live hello advertises creation. */
  eligibleNodes(owner) {
    const { hub, router } = this.controls;
    return hub.db.prepare('SELECT * FROM portable_nodes WHERE owner=? AND revoked_at IS NULL ORDER BY id').all(owner)
      .filter(node => {
        const ws = router?.connections?.get(node.id);
        return ws?.readyState === 1 && ws.portableHello?.capabilities?.botCreation === true;
      });
  }
  chooseNode(owner, nodeId) {
    const eligible = this.eligibleNodes(owner);
    if (nodeId !== undefined) {
      const node = eligible.find(n => n.id === nodeId);
      if (!node) throw fail('That execution machine is not connected or cannot create bots.', 'not-sent');
      return node;
    }
    if (eligible.length === 1) return eligible[0];
    throw fail(eligible.length ? 'Choose which execution machine runs this bot.' : 'No connected execution machine can create bots right now.', 'not-sent');
  }

  async request(owner, { params = {}, operationId }, caller = { kind: 'owner' }) {
    const c = this.controls;
    if (caller.kind !== 'owner') throw fail('Only the owner can create bots.', 'rejected');
    if (typeof operationId !== 'string' || !CREATION_OPERATION.test(operationId))
      throw fail('Bot creation needs a stable operation ID of 10–180 letters, digits, ":", "_" or "-".', 'rejected');
    const command = creationParams(params);
    c.assertWriter();
    const binding = fingerprint({ owner, method: 'bots.create', params, caller });
    const accepted = await c.lock('create', async () => {
      c.assertWriter();
      const prior = c.store.operation(operationId);
      if (prior) {
        if (prior.fingerprint !== binding) throw fail('This operation ID was used for a different bot.', 'rejected');
        if (prior.status === 'done') return { result: prior.result };
        if (prior.status === 'failed') throw fail(prior.error ?? 'Bot creation was refused.', prior.outcome ?? 'rejected');
        const row = c.hub.db.prepare('SELECT * FROM portable_mailbox WHERE operation_id=?').get(operationId);
        if (!row) throw fail('The original creation record is missing; it was not repeated.', 'uncertain');
        return { row };
      }
      const node = this.chooseNode(owner, params.nodeId);
      return { row: c.store.transaction(() => this.reserve(owner, operationId, binding, params, command, node, caller)) };
    });
    if (accepted.result) return accepted.result;
    try {
      await c.router.wait(accepted.row);
    } catch (error) {
      const op = c.store.operation(operationId);
      if (op?.status === 'done') return op.result;
      throw error;
    }
    // The receipt hook runs synchronously before this continuation.
    const op = c.store.operation(operationId);
    if (op?.status === 'done') return op.result;
    throw fail(op?.error ?? 'Bot creation is not confirmed yet; it was not repeated.', op?.status === 'failed' ? op.outcome ?? 'rejected' : 'uncertain');
  }

  /** One transaction: placement, provisional record, mailbox command and operation. */
  reserve(owner, operationId, binding, params, command, node, caller) {
    const c = this.controls;
    c.assertWriter();
    if (c.store.bots({ includeDeleted: true }).some(b => b.id === operationId) ||
        c.store.db.prepare('SELECT 1 FROM portable_placements WHERE bot_id=?').get(operationId))
      throw fail('This bot identity is already in use.', 'rejected');
    c.store.db.prepare('INSERT INTO portable_placements(bot_id,owner,node_id,epoch) VALUES(?,?,?,1)').run(operationId, owner, node.id);
    const at = now();
    c.store.saveBot({
      id: operationId, name: command.name, purpose: command.purpose, slug: `creating-${operationId}`, cwd: null, threadId: null,
      color: null, status: 'provisioning', archived: false, model: null, effort: null, mode: 'default', executionMode: 'single-thread',
      ...(command.provider ? { provider: command.provider } : {}), preview: '', updatedAt: at, lastReadAt: at, activeTurnId: null,
      error: null, portableCreation: { operationId, nodeId: node.id },
    });
    const row = c.hub.enqueueOn(c.store.db, owner, operationId, operationId, { method: 'bots.create', params: command });
    c.store.saveOperation(operationId, binding, 'dispatching', { method: 'bots.create', botId: null, params, caller, nodeId: node.id, createdAt: at });
    return row;
  }

  /**
   * Completes a provisional record from the created native bot, once. Returns
   * the hub record, or null when the native identity contradicts it.
   */
  adopt(botId, native) {
    const b = this.store.bot(botId);
    if (!b.portableCreation) return b.threadId === native?.threadId ? b : null;
    if (native?.id !== botId || !id(native.threadId) || (b.threadId && b.threadId !== native.threadId)) return null;
    let slug = typeof native.slug === 'string' && native.slug ? native.slug : b.slug;
    if (this.store.bots({ includeDeleted: true }).some(other => other.id !== botId && other.slug === slug)) slug = `${slug}-${botId.slice(0, 8)}`;
    const next = { ...b, slug };
    delete next.portableCreation;
    for (const key of IDENTITY) if (Object.hasOwn(native, key)) next[key] = native[key];
    this.store.saveBot(next);
    return next;
  }

  /** Applies a bots.create receipt; called on delivery and by reconciliation. */
  receipt(row) {
    const c = this.controls, receipt = row.receipt && JSON.parse(row.receipt);
    if (!receipt) return;
    c.store.transaction(() => {
      const mark = () => c.store.db.prepare('INSERT INTO portable_control_receipts VALUES(?,?) ON CONFLICT(operation_id) DO UPDATE SET receipt_hash=excluded.receipt_hash').run(row.operation_id, row.receipt_hash);
      const op = c.store.operation(row.operation_id);
      if (!op || op.method !== 'bots.create' || ['done', 'failed'].includes(op.status)) { mark(); return; }
      if (row.state === 'terminal' && receipt.outcome === 'rejected') {
        // Refused before any native effect: release the reservation entirely.
        c.store.db.prepare('DELETE FROM portable_placements WHERE bot_id=? AND node_id=? AND epoch=?').run(row.bot_id, row.node_id, row.epoch);
        const b = c.store.bots({ includeDeleted: true }).find(x => x.id === row.bot_id);
        if (b?.portableCreation && !b.threadId) c.store.db.prepare('DELETE FROM bots WHERE id=?').run(row.bot_id);
        c.store.saveOperation(op.id, op.fingerprint, 'failed', { ...op, outcome: 'rejected', error: receipt.error ?? 'The execution machine refused this bot.' });
        mark(); return;
      }
      if (row.state === 'terminal' && originalCreationProof(receipt, row.operation_id, JSON.parse(row.payload))) {
        const bot = this.adopt(row.bot_id, receipt.result);
        if (!bot) {
          c.store.put('portableReceiptConflict', { id: row.operation_id, botId: row.bot_id, receiptHash: row.receipt_hash, reason: 'Created native bot differs from its hub reservation.', at: now() });
          mark(); return;
        }
        c.store.saveOperation(op.id, op.fingerprint, 'done', { ...op, result: { ...bot, nodeId: row.node_id, placementEpoch: row.epoch }, error: null });
        mark(); return;
      }
      if (row.state === 'unknown') c.store.saveOperation(op.id, op.fingerprint, 'uncertain', { ...op, error: receipt.error ?? 'Bot creation on the execution machine is unconfirmed; it was not repeated.' });
      mark();
    });
  }
}
