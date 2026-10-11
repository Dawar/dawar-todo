import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBKeyRange } from 'fake-indexeddb';
import { runtime } from './helpers/load-ts.mjs';
const page = entries => ({kind:'page',entries,attachments:[],olderCursor:null,revision:'native:thread:conversation-v8',eventCursor:0,complete:true});
const item = (id,type='agentMessage',phase='final_answer') => type === 'commandExecution' ? {id,type,command:'read source',aggregatedOutput:'done',status:'completed',exitCode:0} : {id,type,text:id,phase,content:[],summary:['Summary only']};
function setup() {
  const env=runtime({IDBKeyRange}), {BotTimeline}=env.load('app/bots/timeline-controller.ts');
  const {projectHistoryItem}=env.load('lib/bot-history-view.ts');
  const turn={id:'turn',status:'completed',startedAt:100,completedAt:105,items:[],itemsView:'summary'};
  const entry=i=>projectHistoryItem(turn,i);
  let read=async()=>page([entry(item('answer'))]);
  const transport={owner:'owner',online:true,snapshot:{bots:[{id:'bot',threadId:'thread'}]},rpc:(...args)=>read(...args)};
  const cache={read:async()=>null,write:async()=>{}};
  const timeline=new BotTimeline('owner','bot',transport,cache);
  return {env,entry,transport,timeline,setRead:value=>read=value};
}
const event=(seq,method,params)=>({seq,type:'codex',botId:'bot',data:{method,params:{threadId:'thread',turnId:'turn',...params}}});

test('native items keep identity, sequence and completed tool rows through a summary refresh',async()=>{
  const s=setup();
  s.timeline.receive(event(1,'turn/started',{turn:{id:'turn',status:'inProgress',startedAt:100,items:[],itemsView:'full'}}));
  for(const [n,i] of [item('comment','agentMessage','commentary'),item('command','commandExecution'),item('answer')].entries())s.timeline.receive(event(n+2,'item/completed',{item:i}));
  s.timeline.receive(event(5,'turn/completed',{turn:{id:'turn',status:'completed',startedAt:100,completedAt:105,items:[item('answer')],itemsView:'summary'}}));
  await s.timeline.refreshLatest();
  assert.deepEqual(Array.from(s.timeline.getSnapshot().entries,e=>e.id),['comment','command','answer']);
  assert.equal(s.timeline.getSnapshot().entries[1].itemStatus,'completed');
  await s.timeline.dispose();
});

test('work disclosure coalesces, uses the canonical store and preserves a newer streamed answer',async()=>{
  const s=setup();await s.timeline.refreshLatest();let resolve,calls=0;
  s.setRead(async(method)=>{assert.equal(method,'history.log');calls++;return new Promise(r=>resolve=r);});
  const first=s.timeline.loadWorkLog('turn'),second=s.timeline.loadWorkLog('turn');assert.equal(first,second);
  s.timeline.receive(event(10,'item/completed',{item:{...item('answer'),text:'new live answer'}}));
  resolve({entries:[s.entry(item('command','commandExecution')),s.entry(item('answer'))],attachments:[],olderCursor:null});await first;
  const entries=s.timeline.getSnapshot().entries;
  assert.equal(calls,1);assert.deepEqual(Array.from(entries,e=>e.id),['command','answer']);assert.equal(entries[1].item.text,'new live answer');
  assert.equal(s.timeline.getSnapshot().workLogs.turn.loaded,true);
  await s.timeline.loadWorkLog('turn');assert.equal(calls,1);await s.timeline.dispose();
});

test('foreign work detail is rejected without changing the visible conversation',async()=>{
  const s=setup();await s.timeline.refreshLatest();s.setRead(async()=>({entries:[{...s.entry(item('foreign')),turnId:'other'}],attachments:[],olderCursor:null}));
  await s.timeline.loadWorkLog('turn');assert.match(s.timeline.getSnapshot().workLogs.turn.error,/verified/);
  assert.deepEqual(Array.from(s.timeline.getSnapshot().entries,e=>e.id),['answer']);await s.timeline.dispose();
});

test('owner changes fence late disclosure replies',async()=>{
  const s=setup();await s.timeline.refreshLatest();let resolve;s.setRead(()=>new Promise(r=>resolve=r));
  const pending=s.timeline.loadWorkLog('turn');s.transport.owner='other';resolve({entries:[s.entry(item('private-tool','commandExecution'))],attachments:[],olderCursor:null});await pending;
  assert.deepEqual(Array.from(s.timeline.getSnapshot().entries,e=>e.id),['answer']);await s.timeline.dispose();
});

test('older work pages prepend inside their turn without duplicating answers or crossing turns',async()=>{
  const s=setup();await s.timeline.refreshLatest();let calls=0;s.setRead(async()=>({entries:++calls===1?[s.entry(item('recent','commandExecution')),s.entry(item('answer'))]:[s.entry(item('older','commandExecution')),s.entry(item('recent','commandExecution'))],attachments:[],olderCursor:calls===1?'older':null}));
  await s.timeline.loadWorkLog('turn');await s.timeline.loadWorkLog('turn');
  assert.deepEqual(Array.from(s.timeline.getSnapshot().entries,e=>e.id),['older','recent','answer']);await s.timeline.dispose();
});

test('commentary and partial answers remain messages; tools and thinking are individual work rows',()=>{
  const s=setup();const {nativeWorkItem}=s.env.load('app/bots/native-timeline.ts');
  assert.equal(nativeWorkItem(s.entry(item('comment','agentMessage','commentary'))),false);
  assert.equal(nativeWorkItem(s.entry(item('partial','agentMessage','partial_answer'))),false);
  assert.equal(nativeWorkItem(s.entry(item('unknown','agentMessage',null))),false);
  assert.equal(nativeWorkItem(s.entry(item('command','commandExecution'))),true);
  assert.equal(nativeWorkItem(s.entry(item('reason','reasoning'))),true);
});
