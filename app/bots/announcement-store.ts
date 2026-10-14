import { announcementFinished, type AnnouncementDraft, type AnnouncementIntent, type AnnouncementRecord, type AnnouncementRecipient } from './announcement-state';

type Change = { kind: 'read' } | { kind: 'draft'; version: string; text: string; selected: string[] | null; expected: string } |
  { kind: 'admit'; intent: AnnouncementIntent; expected: string } | { kind: 'settle'; id: string; operationId: string; update: Partial<Pick<AnnouncementRecipient, 'state' | 'detail' | 'queueId' | 'turnId'>> } | { kind: 'new'; id: string };
let connection: Promise<IDBDatabase> | undefined;
function open() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('dawar-announcements-v1', 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('drafts', { keyPath: 'owner' }); request.result.createObjectStore('intents', { keyPath: ['owner', 'id'] }); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(Error('Announcement storage is blocked. Keep the original draft and retry.'));
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); connection = undefined; }; db.onclose = () => { connection = undefined; }; resolve(db); };
  }).catch(error => { connection = undefined; throw error; });
  return connection;
}
/** Admission and immutable per-recipient IDs commit before any queue request. No transcript or composer store is touched. */
export async function announcementJournal(owner: string, change: Change): Promise<AnnouncementRecord> {
  if (!owner) throw Error('Sign in before opening announcements.');
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['drafts', 'intents'], 'readwrite', { durability: 'strict' });
    const drafts = tx.objectStore('drafts'), intents = tx.objectStore('intents');
    let result: AnnouncementRecord, failure: unknown;
    const fail = (error: unknown) => { failure = error; tx.abort(); };
    const guard = (fn: () => void) => () => { try { fn(); } catch (error) { fail(error); } };
    tx.oncomplete = () => {
      if (change.kind !== 'read' && typeof BroadcastChannel !== 'undefined') {
        try { const channel = new BroadcastChannel('dawar-announcements-v1'); channel.postMessage(owner); channel.close(); }
        catch { /* Original durable outcome remains available on reopen/focus. */ }
      }
      resolve(result);
    }; tx.onerror = () => {};
    tx.onabort = () => reject(failure ?? tx.error ?? Error('Announcement storage failed. No new delivery is confirmed.'));
    const request = drafts.get(owner);
    request.onsuccess = guard(() => {
      const draft: AnnouncementDraft = request.result ?? { owner, revision: 0, version: 'empty', text: '', selected: null, activeId: null };
      const loaded = (intent: AnnouncementIntent | null) => {
        if (draft.activeId && (!intent || intent.owner !== owner || intent.id !== draft.activeId)) throw Error('The original announcement record is unavailable. Keep its identity and retry storage.');
        if (change.kind === 'draft') {
          if (draft.activeId || draft.version !== change.expected) throw Error('This announcement changed in another tab. Reload its saved draft before continuing.');
          draft.text = change.text; draft.selected = change.selected; draft.version = change.version; draft.revision++;
        }
        if (change.kind === 'admit') {
          if (change.intent.owner !== owner) throw Error('Announcement owner changed.');
          if (!intent) {
            if (draft.version !== change.expected || draft.text !== change.intent.text) throw Error('The announcement draft changed before Send. Review it again.');
            intent = change.intent; intents.add(intent); draft.activeId = intent.id; draft.text = ''; draft.revision++;
          } else if (intent.text !== change.intent.text || JSON.stringify(intent.recipients.map(r => r.id)) !== JSON.stringify(change.intent.recipients.map(r => r.id))) throw Error('Finish the original announcement before creating another.');
        }
        if (change.kind === 'settle') {
          if (!intent || intent.id !== change.id) throw Error('The original announcement changed. Its receipt was retained.');
          const recipient = intent.recipients.find(r => r.operationId === change.operationId);
          if (!recipient) throw Error('The original recipient identity is unavailable.');
          // A late failure cannot replace a positive or rejected original receipt.
          if (!['queued', 'accepted', 'rejected'].includes(recipient.state)) {
            Object.assign(recipient, change.update); intents.put(intent); draft.revision++;
          }
        }
        if (change.kind === 'new') {
          if (!intent || intent.id !== change.id || !announcementFinished(intent)) throw Error('Resolve the original recipients before a new announcement.');
          draft.activeId = null; draft.version = crypto.randomUUID(); draft.selected = null; draft.revision++; intent = null;
        }
        drafts.put(draft); result = { draft, intent };
      };
      if (!draft.activeId) { loaded(null); return; }
      const read = intents.get([owner, draft.activeId]); read.onsuccess = guard(() => loaded(read.result ?? null));
    });
  });
}
