// Production UI, native browser stores, public synthetic content only.
import React, { Activity } from 'react';
import { createRoot } from 'react-dom/client';
import { BotsWorkspace } from '../../app/bots/workspace';
import { botsClient as client } from '../../app/bots/client';
import { botComposers } from '../../app/bots/composer-service';
import { historyTail } from '../../lib/bot-history-view';
import { getBotTimeline } from '../../app/bots/use-timeline';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label) => { for (let i = 0; i < 500; i++) { if (fn()) return; await wait(10); } throw new Error(label); };
const check = (value, label) => { if (!value) throw new Error(label); };
const bot = (id, name, purpose) => ({ id, name, purpose, slug: id, cwd: '/synthetic', threadId: id, color: '#3d8065', status: 'idle', archived: false, model: 'gpt-6', effort: 'high', mode: 'default', preview: purpose, updatedAt: '2026-09-27T09:30:00Z', lastReadAt: '2026-09-27T09:30:00Z', activeTurnId: null });
const bots = [bot('design-a', 'Studio · Planning & ideas', 'A little clarity for your next big thing.'), bot('design-b', 'Field notes', 'Keep the details worth remembering.')];
const snapshot = { bots, pending: [], cursor: 0, ready: true, models: [{ id: 'gpt-6', model: 'gpt-6', displayName: 'GPT-6', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], serviceTiers: [{ id: 'fast' }] }], schedules: [], runs: [], defaults: { model: 'gpt-6', effort: 'high' } };
const syntheticSession = crypto.randomUUID();
let scene = 'populated', galleryScene = 'populated', generation = 0, delayedSearch = '';
const root = createRoot(document.getElementById('root'));
const show = (mode = 'visible') => root.render(<Activity mode={mode}><BotsWorkspace /></Activity>);
const field = () => document.querySelector('.bots-composer textarea');
const selected = () => new URLSearchParams(location.search).get('bot') || 'design-a';
const composer = () => botComposers.peek(client.owner, selected());
const message = (id, text, type = 'agentMessage') => type === 'userMessage' ? { id, type, content: [{ type: 'text', text, text_elements: [] }] } : { id, type, text, phase: 'final_answer', memoryCitation: null, questions: null, delivery: null };
const turns = () => scene === 'empty' ? [] : [{ id: 'design-turn', status: 'completed', startedAt: 1789891200, itemsView: 'full', items: [
  message('user', 'Help me make room for the work that matters this week.', 'userMessage'),
  ...Array.from({ length: 2 }, (_, i) => ({ id: `tool-${i}`, type: 'commandExecution', command: 'Review weekly notes', status: 'completed', aggregatedOutput: 'A synthetic work note. No real account data.' })),
  message('answer', '### A lighter week, with a little more focus\n\nStart with one meaningful outcome: **finish the launch story**. Give it your best hour before the small things take over.\n\n- **Monday:** shape the idea and choose three examples.\n- **Tuesday:** write the first draft, then take a walk.\n- **Wednesday:** share it with someone whose taste you trust.\n\nLeave a little white space. A good plan should help you breathe.'),
  message('followup', 'Love this. Let’s keep Friday open.', 'userMessage'),
  message('last', 'Friday stays open. We can use it for a final polish—or simply enjoy having finished early.'),
] }];
client.start = () => {};
const rpcCalls = [];
client.rpc = async (method, botId, params, _id, options) => {
  if (method.startsWith('artifacts.') || method === 'attachments.read' || scene === 'outputs' && ['history.view', 'history.detail'].includes(method)) {
    if (!method.startsWith('history.')) check(options?.owner === client.owner, 'artifact request missing captured owner');
    const call = { method, botId, params, owner: client.owner }; rpcCalls.push(call);
    if (!client.online) throw new Error('Synthetic offline transport');
    if (method === 'artifacts.index' && galleryScene === 'index-error') throw new Error('An earlier file could not be read. Try again when your bot reconnects.');
    if (method === 'artifacts.index' && galleryScene === 'index-more') return { registered:0, nextCursor: params.cursor ? null : 'synthetic-older', failures:[] };
    if (method === 'artifacts.list') {
      if (galleryScene === 'loading') return new Promise(() => {});
      await wait(params.search === delayedSearch && delayedSearch ? 1100 : 120);
      if (galleryScene === 'error') throw new Error('We couldn’t reach your files. Please try again in a moment.');
      if (galleryScene === 'empty') return { items: [], nextCursor: null };
    }
    const response = await fetch('/artifact-rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, botId, params }) }).then((r) => r.json());
    if (response.error) throw new Error(response.error);
    call.bytes = new TextEncoder().encode(JSON.stringify(response.result)).length;
    if (method.startsWith('history.')) call.attachments = response.result.attachments;
    return response.result;
  }
  if (method === 'history.view') {
    if (scene === 'loading') return new Promise(() => {});
    await wait(30);
    if (scene === 'error') throw new Error('The conversation could not load. Your draft is safe.');
    return { kind: 'page', entries: historyTail(turns()), contextEntries: [], attachments: [], olderCursor: null, revision: 'design', eventCursor: 0, complete: true };
  }
  if (method === 'history.detail') { const item = turns()[0].items.find((x) => x.id === params.itemId); return { json: JSON.stringify(item), nextOffset: null, totalLength: 100, version: 'design', eventCursor: 0 }; }
  if (method === 'usage.account') return { accountType: 'chatgpt', ordinaryUsageAllowed: true, availableResetCredits: null, limits: [{ limitId: 'standard', limitName: 'Your plan', model: null, windows: [{ usedPercent: 12, windowDurationMins: 10080, resetsAt: Math.floor(Date.now()/1000) + 183840 }, { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000)+10860 }] }], readAt: new Date().toISOString() };
  if (method === 'turn.send') return { turn: { id: 'synthetic-sent' } };
  return [];
};
const select = (id) => { history.pushState({}, '', `/preview?bot=${id}`); window.dispatchEvent(new PopStateEvent('popstate')); };
window.design = {
  rpcCalls,
  async scenario(name = 'populated') {
    scene = name; client.owner = `design-owner-${syntheticSession}-${++generation}`; client.online = name !== 'offline'; client.error = ''; client.snapshot = { ...snapshot, bots: [...bots] };
    client.notify(); select('design-a'); show();
    await until(() => composer()?.ready && field(), 'composer ready'); await wait(150);
    if (name === 'offline') { const timeline = getBotTimeline(client.owner, 'design-a'); timeline.seed(turns(), []); await timeline.flush(); }
    if (name === 'recovery') { this.type('Keep this draft safe while I reconnect.'); await composer().flush(); composer().storageError = 'This draft could not be saved. Your words are still here; retry before closing.'; client.notify(); }
    await wait(100); return this.layout();
  },
  async gallery(name = 'populated', scope = 'all') {
    galleryScene = name; await this.scenario(name === 'offline' ? 'offline' : 'populated');
    const params = new URLSearchParams({ view: scope === 'all' ? 'artifacts' : 'attachments' }); if (scope !== 'all') params.set('bot', 'design-a');
    history.pushState({}, '', `/preview?${params}`); window.dispatchEvent(new PopStateEvent('popstate')); await wait(450); if (name === 'populated') await until(() => document.querySelector('.bots-file-card'), 'gallery cards');
    return { cards: document.querySelectorAll('.bots-file-card').length, months: [...document.querySelectorAll('.bots-gallery-month h2')].map((el) => el.textContent) };
  },
  async discoveryChecks() {
    await this.gallery('index-more','bot');await until(()=>document.querySelector('.bots-gallery-discovery button'),'earlier discovery action');
    const before=rpcCalls.filter((r)=>r.method==='artifacts.index').length;
    await wait(200);check(rpcCalls.filter((r)=>r.method==='artifacts.index').length===before,'discovery scanned older pages automatically');
    document.querySelector('.bots-gallery-discovery button').click();await wait(350);
    check(rpcCalls.filter((r)=>r.method==='artifacts.index').length===before+1,'earlier discovery was not one bounded page');
    await this.gallery('index-error','bot');await until(()=>document.querySelector('.bots-gallery-discovery')?.textContent.includes('another try'),'recoverable indexing error');
    galleryScene='populated';[...document.querySelectorAll('.bots-gallery-discovery button')].find((b)=>b.textContent==='Retry').click();await wait(350);
    check(!document.querySelector('.bots-gallery-discovery'),'successful indexing retry did not settle');
    return {boundedEarlierPage:true, explicitContinuation:true, recoverableIndexError:true};
  },
  async outputCards() {
    const start = rpcCalls.length;
    galleryScene='populated';await this.scenario('outputs');
    await until(()=>document.querySelector('.bots-agent .bots-returned-file'),'published Markdown link becomes a real output card');
    const card=document.querySelector('.bots-agent .bots-returned-file');
    check(card.textContent.includes('A considered plan.pdf'),'real history metadata filename missing');
    const nativeCard = document.querySelector('.bots-returned-files .bots-returned-file');
    check(nativeCard?.textContent.includes('Forest study.png'), 'native output metadata card missing from fresh history');
    check(document.querySelectorAll('.bots-returned-file').length===2,'same delivered file duplicated in work log and reply');
    check(!document.querySelector('.bots-activity[open]'),'work log opened to show output');
    await until(()=>[card,nativeCard].every((el)=>el.querySelector('img')?.complete && el.querySelector('img').naturalWidth > 0),'real message-local PDF and image thumbnails');
    const initialCalls = rpcCalls.slice(start), view = initialCalls.find((call)=>call.method==='history.view');
    const files = view?.attachments ?? [];
    check(files.length===2 && files.every((file)=>file.size>0 && file.preview?.version),'history.view must supply bounded complete metadata');
    check(files.some((file)=>file.source==='native' && file.provenance?.itemId==='output-3'),'registered native output provenance missing');
    check(!initialCalls.some((call)=>call.method==='history.detail' || call.method==='attachments.read'),'closed work eagerly downloaded detail or originals');
    check(!initialCalls.some((call)=>call.method==='artifacts.list' || call.method==='artifacts.index'),'fresh history borrowed gallery metadata');
    card.click();await until(()=>document.querySelector('.bots-file-viewer iframe'),'message-local PDF original');
    await this.galleryAction('close');await wait(30);
    nativeCard.click();await until(()=>document.querySelector('.bots-file-viewer-body > img')?.complete,'message-local image original');
    await this.galleryAction('close');await wait(30);
    document.querySelector('.bots-activity > summary').click();
    await until(()=>document.querySelectorAll('.bots-activity .bots-activity > summary').length===2, 'individual work disclosures');
    document.querySelectorAll('.bots-activity .bots-activity > summary').forEach((summary)=>summary.click());
    await until(()=>rpcCalls.slice(start).filter((call)=>call.method==='history.detail' && call.attachments?.length).length===2,'opened work must use real history.detail metadata');
    const details = rpcCalls.slice(start).filter((call)=>call.method==='history.detail');
    check(details.some((call)=>call.params.itemId==='tool-0' && call.attachments.some((file)=>file.name==='A considered plan.pdf')),'published detail metadata missing');
    check(details.some((call)=>call.params.itemId==='output-3' && call.attachments.some((file)=>file.name==='Forest study.png' && file.source==='native')),'native detail metadata missing');
    document.querySelector('.bots-activity > summary').click();await wait(50);
    return {publishedLink:true,nativeOutput:true,realPdfPreview:true,realImagePreview:true,originalViewers:true,closedWorkLog:true,closedDetailRequests:0,eagerOriginals:0,galleryMetadataRequests:0,historyViewBytes:view.bytes,historyDetailBytes:details.map((call)=>call.bytes)};
  },
  async galleryCountChecks(single = false) {
    const cards = () => [...document.querySelectorAll('.bots-file-card')];
    const label = () => document.querySelector('.bots-gallery-total')?.textContent;
    if (single) {
      const input = document.querySelector('[aria-label="Search files"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'One final note');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await until(() => cards().length === 1 && label() === '1 file', 'honest singular inventory');
      check(document.querySelector('.bots-gallery-month h2')?.textContent === 'Date unknown1 file', 'singular month count');
      await until(() => cards()[0].querySelector('img')?.naturalWidth > 0, 'single PDF thumbnail');
      return { header: label(), cards: cards().length, unknownDate: true };
    }
    await this.gallery('populated');
    // Native output indexing can schedule its single coalesced first-page refresh.
    await wait(650);
    await until(() => !document.querySelector('.bots-gallery-pages button:last-child')?.disabled, 'first page settled');
    check(label() === '36+ files', 'first page lower bound');
    const before = rpcCalls.filter((r) => r.method === 'artifacts.list').length;
    for (const page of [2, 3]) {
      document.querySelector('.bots-gallery-pages button:last-child').click();
      await until(() => label()?.startsWith(`Page ${page} ·`), `page ${page} count`);
    }
    check(label() === 'Page 3 · 8 files', 'last page size masquerades as inventory');
    check(cards().length === 8, 'last page fixture');
    const months = [...document.querySelectorAll('.bots-gallery-month h2')].map((el) => el.textContent);
    check(months.every((text) => text.endsWith('files on this page')), 'month counts must be page scoped');
    check(document.querySelector('.bots-gallery-pages button:last-child').disabled, 'last page has no older cursor');
    const requests = rpcCalls.filter((r) => r.method === 'artifacts.list').length - before;
    check(requests === 2, 'count labels must not iterate inventory');
    check(document.body.scrollWidth <= innerWidth + 1, 'count wording overflows viewport');
    await until(() => cards().filter((el) => el.getBoundingClientRect().top < innerHeight && el.querySelector('.is-image,.is-pdf')).every((el) => el.querySelector('img')?.naturalWidth > 0), 'visible last-page previews settled');
    return { header: label(), cards: cards().length, months, requests };
  },
  async galleryChecks() {
    const cards = () => [...document.querySelectorAll('.bots-file-card')];
    const text = (selector, value) => { const el = document.querySelector(selector); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el,value); el.dispatchEvent(new Event('input',{bubbles:true})); };
    const choose = (value) => { const el=document.querySelector('[aria-label="Filter by bot"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('change',{bubbles:true})); };
    const type = (label) => [...document.querySelectorAll('.bots-gallery-types button')].find((el)=>el.textContent===label).click();
    await until(()=>cards().length===36,'bounded first page');
    await until(()=>cards().slice(0,2).every((el)=>el.querySelector('img')?.complete),'real image and PDF previews');
    const initialOriginals=rpcCalls.filter((r)=>r.method==='attachments.read').length;
    check(initialOriginals===0,'listing eagerly downloaded originals');
    const first=cards()[0].dataset.artifactId;
    document.querySelector('.bots-gallery-pages button:last-child').click(); await wait(350);
    check(cards()[0].dataset.artifactId!==first,'older page did not advance');
    document.querySelector('.bots-gallery-pages button:first-child').click(); await wait(350);
    check(cards()[0].dataset.artifactId===first,'newer page did not return');
    type('PDFs'); await wait(350); check(cards().length>0 && cards().every((el)=>el.querySelector('.is-pdf')),'PDF filter');
    text('[aria-label="Search files"]','Weekly'); await wait(650);
    check(cards().every((el)=>el.textContent.includes('Weekly')),'filename search');
    choose('design-b'); await wait(350);check(cards().length && cards().every((el)=>el.querySelector('.bots-file-bot')?.textContent==='Field notes'),'bot attribution/filter');
    choose(''); text('[aria-label="Search files"]','');type('All files');await wait(650);
    delayedSearch='Quiet'; text('[aria-label="Search files"]','Quiet'); await wait(350);
    text('[aria-label="Search files"]','Weekly'); await wait(1550);
    check(cards().length && cards().every((el)=>el.textContent.includes('Weekly')),'stale search response won');delayedSearch='';
    text('[aria-label="Search files"]','');await wait(650);
    const scroll=document.querySelector('.bots-gallery-scroll');scroll.scrollTop=400;scroll.dispatchEvent(new Event('scroll'));await wait(30);
    const saved=scroll.scrollTop;document.querySelector('[aria-label="Back to bots"]').click();await wait(40);document.querySelector('.bots-artifacts-nav').click();await wait(350);
    check(Math.abs(document.querySelector('.bots-gallery-scroll').scrollTop-saved)<2,'gallery navigation lost reading position');
    document.querySelector('.bots-gallery-scroll').scrollTop=0;
    const before=rpcCalls.filter((r)=>r.method==='artifacts.list').length;
    for(let i=0;i<15;i++) for(const listener of client.events) listener({seq:i+20,type:'attachment',botId:'design-a',data:{}});
    await wait(650);check(rpcCalls.filter((r)=>r.method==='artifacts.list').length-before===1,'attachment burst caused request storm');
    const originalButton=cards()[0].querySelector('button');originalButton.focus();originalButton.click();await until(()=>document.querySelector('.bots-file-viewer-body > img')?.complete,'original image viewer');await wait(100);
    const source=document.querySelector('.bots-file-viewer-body > img').src, reads=rpcCalls.filter((r)=>r.method==='attachments.read').length;
    client.online=false;client.notify();await wait(100);
    check(document.querySelector('.bots-file-viewer-body > img').src===source && !document.querySelector('.bots-file-viewer footer button:last-child').disabled,'connection loss discarded an already-open original');
    client.online=true;client.notify();await wait(350);check(rpcCalls.filter((r)=>r.method==='attachments.read').length===reads,'reconnect refetched an already-open original');
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait(30);check(!document.querySelector('.bots-file-viewer'),'Escape did not close');check(document.activeElement===originalButton,'viewer focus did not restore');
    await until(()=>cards()[0].querySelector('img')?.complete,'cached first thumbnail');await wait(100);
    sessionStorage.setItem('design-offline-owner',client.owner);
    return { boundedCards:36, lazyOriginals:initialOriginals, pagination:true, search:true, typeFilter:true, botFilter:true, staleResponseRejected:true, restoredScroll:saved, attachmentBurstRequests:1, viewerFocus:true, openOriginalSurvivesOffline:true };
  },
  async offlineReload() {
    galleryScene='populated';scene='populated';client.owner=sessionStorage.getItem('design-offline-owner');client.online=false;client.error='';client.snapshot={...snapshot,bots:[...bots]};client.notify();
    history.replaceState({},'', '/preview?view=artifacts');window.dispatchEvent(new PopStateEvent('popstate'));show();
    await until(()=>document.querySelectorAll('.bots-file-card').length>0,'offline cached gallery after page restart');
    await until(()=>document.querySelector('.bots-file-card img')?.complete,'offline cached thumbnail');
    const calls=rpcCalls.length;const count=document.querySelectorAll('.bots-file-card').length;
    document.querySelector('.bots-file-card button').click();await until(()=>document.querySelector('.bots-file-viewer-body > img')?.complete,'offline preview');await wait(100);
    check(rpcCalls.length===calls,'offline viewer attempted an original request');check(document.querySelector('.bots-file-viewer-notice')?.textContent.includes('Saved preview'),'offline preview label missing');
    return { cards:count, preview:true, networkCalls:rpcCalls.length };
  },
  async galleryAction(name) {
    if (name === 'image' || name === 'pdf') { const card = [...document.querySelectorAll('.bots-file-card')].find((card) => card.querySelector(`.is-${name}`)); card.querySelector('button').click(); await wait(500); return { viewer: Boolean(document.querySelector('.bots-file-viewer')), pdf: Boolean(document.querySelector('.bots-file-viewer iframe')), image: Boolean(document.querySelector('.bots-file-viewer-body > img')) }; }
    if (name === 'close') document.querySelector('[aria-label="Close preview"]').click();
    if (name === 'quota') { select('design-a'); await wait(100); document.querySelector('[aria-label="Bot details and schedules"]').click(); await wait(250); const meter=document.querySelector('[role="meter"]'); check(meter?.getAttribute('aria-valuenow')==='88','quota remaining must be 88'); return {remaining:88}; }
  },
  type(value) { const el = field(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); },
  async restored(value) { composer().setText(value); await composer().flush(); await wait(40); },
  select,
  async activity() { show('hidden'); await wait(60); show(); await wait(100); },
  async keyboard(height) { field().focus(); Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => height }); visualViewport.dispatchEvent(new Event('resize')); await wait(300); },
  async dismissKeyboard() { field().blur(); Object.defineProperty(visualViewport, 'height', { configurable: true, get: () => innerHeight }); visualViewport.dispatchEvent(new Event('resize')); await wait(300); },
  async emptyHeightReproduction() {
    this.type('A typed draft before send.\n'.repeat(18)); await composer().flush(); await wait(60);
    const typedHeight = field().getBoundingClientRect().height;
    await this.restored(''); field().blur();
    return { typedHeight, emptyHeight: field().getBoundingClientRect().height, focused: document.activeElement === field() };
  },
  async tallRegression() {
    await this.restored('A long draft before send.\n'.repeat(16)); const tall = field().getBoundingClientRect().height;
    await this.restored(''); field().blur(); const cleared = field().getBoundingClientRect().height;
    check(cleared <= 42 && tall > cleared, 'restored/cleared empty textarea retained height');
    await this.restored('A second long draft\n'.repeat(12)); select('design-b'); await until(() => field()?.value === '', 'empty bot switch'); await wait(60);
    check(field().getBoundingClientRect().height <= 42, 'empty switched bot retained height');
    select('design-a'); await until(() => field()?.value.includes('second'), 'restore long draft'); await wait(60);
    check(field().getBoundingClientRect().height > 42, 'long restored draft did not resize');
    await this.restored(''); await this.activity(); check(field().getBoundingClientRect().height <= 42, 'Activity empty height');
    this.type('Send me'); await composer().flush(); await composer().send(); await wait(70); check(field().value === '' && field().getBoundingClientRect().height <= 42, 'sent empty height');
    field().placeholder = 'An intentionally very long placeholder '.repeat(20);
    window.dispatchEvent(new Event('resize')); await wait(50); check(field().getBoundingClientRect().height <= 42, 'placeholder changed empty height');
    await this.restored('One line'); field().style.lineHeight = '32px'; await wait(60);
    check(field().getBoundingClientRect().height >= 48, 'font change did not remeasure');
    field().style.lineHeight = ''; await this.restored(''); field().placeholder = 'Message…';
    return { restoredHeight: tall, clearedHeight: cleared, botSwitch: true, activity: true, send: true, longPlaceholder: true, fontChange: true };
  },
  async jumpCheck() {
    const scroll = document.querySelector('.bots-messages'); scroll.scrollTop = 0; scroll.dispatchEvent(new Event('scroll')); await wait(40);
    const away = scroll.scrollHeight - scroll.clientHeight > 120;
    check(Boolean(document.querySelector('.bots-jump-latest')) === away, 'jump away visibility');
    if (away) document.querySelector('.bots-jump-latest').click(); await wait(50);
    check(!document.querySelector('.bots-jump-latest'), 'jump remains at bottom');
    check(!document.querySelector('.bots-messages').textContent.includes('Files and artifacts'), 'artifact tail remains');
    const disclosure = document.querySelector('.bots-activity > summary'); disclosure?.click(); await wait(70);
    check(!document.querySelector('.bots-jump-latest'), 'tool expansion abandoned follow-latest');
    client.receive({ type: 'event', event: { seq: 1, botId: selected(), type: 'codex', data: { method: 'item/agentMessage/delta', params: { turnId: 'design-turn', itemId: 'last', delta: '\n\nOne more thought. '.repeat(15) } } } });
    await wait(100); check(!document.querySelector('.bots-jump-latest'), 'stream abandoned follow-latest');
    const late=document.createElement('img');late.alt='Synthetic delayed image';late.style.width='100%';
    document.querySelector('.bots-messages > div').append(late);await wait(30);
    late.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#e4eadb"/></svg>');
    await wait(100);check(!document.querySelector('.bots-jump-latest'),'late image abandoned follow-latest');late.remove();await wait(40);
    return { showedAway: away, hiddenAtBottom: true, expandedTool: true, stream: true, lateImage: true };
  },
  layout() { const el = field(), r = el?.getBoundingClientRect(); return { width: innerWidth, height: innerHeight, visualHeight: visualViewport.height, inputHeight: r?.height, inputBottom: r?.bottom, value: el?.value, hasJump: Boolean(document.querySelector('.bots-jump-latest')), routineStatus: Boolean(document.querySelector('.bots-draft-status')), bodyWidth: document.body.scrollWidth }; },
};
