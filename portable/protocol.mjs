import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readPrivate,savePrivate } from './private-file.mjs';
import { CODEX_VERSION } from '../bot-bridge/codex-version.mjs';
import {roomQuestionSource} from './control-protocol.mjs';

export const PROTOCOL_VERSION = 1;
export const RUNTIME_VERSION = CODEX_VERSION;
export const MAX_FRAME_BYTES = 1024 * 1024;
// ISO occurrence identities contain a fractional-second period. Preserve
// those original scheduled IDs instead of manufacturing replacement tokens.
export const id = value => typeof value === 'string' && /^[A-Za-z0-9:_.-]{1,180}$/.test(value);
export const digest = value => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');

export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && [Object.prototype,null].includes(Object.getPrototypeOf(value)))
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  throw Error('Noncanonical protocol value.');
}
export const fingerprint = value => digest(canonical(value));
export function originalNativeProof(receipt,operationId) {
  const e=receipt?.evidence;
  return e?.kind==='original-native-client'&&e.operationId===operationId&&receipt.operationId===operationId
    &&id(receipt.threadId)&&id(receipt.turnId)&&e.threadId===receipt.threadId&&e.turnId===receipt.turnId
    &&(receipt.result?.turn?.id??receipt.result?.turnId)===receipt.turnId;
}
export function originalLocalControlProof(receipt,operationId,hash,payload) {
  const e=receipt?.evidence,p=payload?.params;
  if(payload?.method==='portable.roomRespond'){
    const q=p?.question,r=receipt?.result;
    if(!q?.request||!p?.agentEpoch||!q.key||!q.contextId)return false;
    return q.async!==true&&q.epoch===p.agentEpoch&&fingerprint(roomQuestionSource(q))===p.questionFingerprint&&e?.kind==='original-native-response'&&receipt.operationId===operationId&&e.operationId===operationId&&e.fingerprint===hash
      &&id(q.threadId)&&id(q.turnId)&&receipt.threadId===q.threadId&&receipt.turnId===q.turnId&&e.threadId===q.threadId&&e.turnId===q.turnId&&e.key===q.key&&e.contextId===q.contextId
      &&e.agentEpoch===p.agentEpoch&&e.nativeRequestId===q.request.id&&e.questionFingerprint===p.questionFingerprint&&e.resultFingerprint===fingerprint(p.result)
      &&r?.state==='written'&&r.confirmation==='native-stdio-write'&&r.operationId===operationId&&r.key===q.key&&r.contextId===q.contextId&&r.agentEpoch===p.agentEpoch&&r.threadId===q.threadId&&r.turnId===q.turnId;
  }
  return payload?.method==='portable.queueResume'&&e?.kind==='original-local-control'&&e.method===payload.method
    &&receipt.operationId===operationId&&e.operationId===operationId&&e.fingerprint===hash
    &&id(receipt.threadId)&&receipt.threadId===p.threadId&&e.threadId===p.threadId
    &&Number.isSafeInteger(p.controlRevision)&&e.controlRevision===p.controlRevision&&receipt.result!==undefined;
}
export function boundedFrame(value) {
  const text = canonical(value);
  if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw Error('Protocol frame exceeds its bound.');
  return text;
}
export function publicFingerprint(key) {
  const parsed = createPublicKey(key);
  if (parsed.asymmetricKeyType !== 'ed25519') throw Error('Node key must be Ed25519.');
  return digest(parsed.export({ format: 'der', type: 'spki' }));
}
export function signature(key, value) { return sign(null, Buffer.from(canonical(value)), createPrivateKey(key)).toString('base64url'); }
export function verifySignature(key, value, proof) {
  try {
    return typeof proof === 'string' && proof.length <= 180 && createPublicKey(key).asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(canonical(value)), createPublicKey(key), Buffer.from(proof, 'base64url'));
  } catch { return false; }
}
export function nodeKey(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    const keys = generateKeyPairSync('ed25519');
    savePrivate(path, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { exclusive:true });
  }
  const privateKey = readPrivate(path,4096);
  const publicKey = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString();
  return { privateKey, publicKey, fingerprint: publicFingerprint(publicKey) };
}

export function compatible(hello) {
  if (hello?.protocol !== PROTOCOL_VERSION || hello.runtime !== RUNTIME_VERSION
    || !['linux', 'darwin'].includes(hello.platform) || !['arm64', 'x64'].includes(hello.arch)
    || !hello.capabilities || hello.capabilities.text !== true || hello.capabilities.localStdio !== true)
    throw Error('Incompatible node protocol, runtime or capabilities.');
  // Mac Goals use the shared native protocol. Desktop/voice/secure capabilities remain separately gated.
  if (hello.platform === 'darwin' && ['desktop', 'voice', 'secureTransfer'].some(k => hello.capabilities[k] === true))
    throw Error('Mac capability has not been validated.');
}
