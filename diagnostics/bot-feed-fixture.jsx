import '../tests/fixtures/bot-design-browser.jsx';
import { botsClient as client, BotRpcError } from '../app/bots/client';
import { getBotTimeline } from '../app/bots/use-timeline';
import { timelineCache } from '../app/bots/timeline-cache';
const original = client.rpc.bind(client);
let enabled = false, sequence = 1000;
const calls = [];
client.rpc = async (method, botId, params, ...rest) => {
  if (!enabled || !method.startsWith('history.')) return original(method, botId, params, ...rest);
  if (!client.online) throw Error('Synthetic offline');
  const result = await fetch('/history-rpc', { method:'POST', body:JSON.stringify({method,botId,params}) }).then(r=>r.json());
  if (result.error) throw Error(result.error);
  calls.push({method,params,bytes:JSON.stringify(result).length}); return result;
};
window.feed = {
  calls,
  client,
  BotRpcError,
  timeline:()=>getBotTimeline(client.owner,'design-a'),
  async open(){enabled=true; calls.length=0; await design.scenario('populated');},
  async cache(){await this.timeline().flush(); return timelineCache.read(client.owner,'design-a');},
  event(method,params){const t=this.timeline();sequence=Math.max(sequence,t.getSnapshot().eventCursor)+1;t.receive({seq:sequence,type:'codex',botId:'design-a',data:{method,params}});},
  snapshot(){const s=this.timeline().getSnapshot();return {entries:s.entries.map(e=>({id:e.id,turnId:e.turnId,type:e.type,status:e.status,turnStatus:e.turnStatus,clientId:e.item?.clientId})),position:s.position,gaps:s.gaps,olderCursor:s.olderCursor,revision:s.revision};},
  geometry(){const e=document.querySelector('.bots-messages'),top=e.getBoundingClientRect().top;const nodes=[...e.querySelectorAll('[data-history-key]')];const anchor=nodes.find(n=>n.getBoundingClientRect().bottom>top);return {top:e.scrollTop,height:e.clientHeight,scrollHeight:e.scrollHeight,anchor:anchor?.dataset.historyKey,offset:anchor?.getBoundingClientRect().top-top,keys:nodes.map(n=>n.dataset.historyKey),input:document.querySelector('.bots-composer textarea').getBoundingClientRect().height,jump:!!document.querySelector('.bots-jump-latest')};},
};
feed.evict=()=>{for(let i=0;i<13;i++)getBotTimeline(client.owner,'unused-inspection-'+i);};
feed.cacheApi=timelineCache;
