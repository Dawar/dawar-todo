import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const PROTOCOL_VERSION = 1;
export const RUNTIME_VERSION = '0.161.0';
export const MAX_FRAME_BYTES = 1024 * 1024;
export const id = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,180}$/.test(value);
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
    writeFileSync(path, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
  }
  chmodSync(path, 0o600);
  const privateKey = readFileSync(path, 'utf8');
  const publicKey = createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString();
  return { privateKey, publicKey, fingerprint: publicFingerprint(publicKey) };
}

export function compatible(hello) {
  if (hello?.protocol !== PROTOCOL_VERSION || hello.runtime !== RUNTIME_VERSION
    || !['linux', 'darwin'].includes(hello.platform) || !['arm64', 'x64'].includes(hello.arch)
    || !hello.capabilities || hello.capabilities.text !== true || hello.capabilities.localStdio !== true)
    throw Error('Incompatible node protocol, runtime or capabilities.');
  // The initial Mac pilot has no implied desktop/voice/secure/Goal authority.
  if (hello.platform === 'darwin' && ['desktop', 'voice', 'secureTransfer', 'autonomousGoals'].some(k => hello.capabilities[k] === true))
    throw Error('Mac capability has not been validated.');
}
