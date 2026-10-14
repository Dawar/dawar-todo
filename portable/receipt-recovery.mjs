import { id } from './protocol.mjs';

// Authenticated hub requests only a previously persisted original receipt.
// A missing or conflicting journal is never permission to execute an input.
export function originalJournalReceipt(journal, request, enrollment) {
  if(!id(request?.operation_id)||!id(request.bot_id)||request.node_id!==enrollment.nodeId||
      !Number.isSafeInteger(request.epoch)||request.epoch<1||
      !/^[a-f0-9]{64}$/.test(request.fingerprint??'')||
      !journal.currentControl({bot_id:request.bot_id,epoch:request.epoch}))
    throw Error('Receipt recovery scope is not synchronized.');
  const row=journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(request.operation_id);
  if(!row||row.fingerprint!==request.fingerprint||
      !['unknown','native-accepted','running','terminal'].includes(row.state)||!row.receipt)
    throw Error('Original receipt journal is missing or conflicting; no input was repeated.');
  const command=JSON.parse(row.command),receipt=JSON.parse(row.receipt);
  if(command.owner!==enrollment.owner||command.node_id!==request.node_id||command.bot_id!==request.bot_id||
      command.epoch!==request.epoch||command.fingerprint!==request.fingerprint||receipt.operationId!==request.operation_id)
    throw Error('Original receipt identity differs; no input was repeated.');
  return row;
}
