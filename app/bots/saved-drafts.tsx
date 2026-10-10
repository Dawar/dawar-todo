"use client";
import {useEffect,useState} from 'react';
import type {Bot} from '../../lib/bots-types';
import type {DraftRecord} from './draft-store';
import type {BotComposer} from './composer-controller';
import {botComposers} from './composer-service';
/** Recovery is available deliberately, without status banners over every draft. */
export function SavedDrafts({owner,bots,composer}:{owner:string;bots:Bot[];composer:BotComposer|null}) {
  const [records,setRecords]=useState<DraftRecord[]>([]),[error,setError]=useState('');
  useEffect(()=>{let active=true;void botComposers.savedDrafts(owner).then(rows=>{if(active)setRecords(rows);}).catch(()=>{if(active)setError('Saved drafts could not load.');});return()=>{active=false;};},[owner]);
  if(!composer)return null;
  return <details className="bots-saved-drafts"><summary>Saved drafts</summary>
    {error&&<p role="alert">{error}</p>}
    {records.map(record=><div key={record.botId}><span>{bots.find(bot=>bot.id===record.botId)?.name??'Earlier shared draft'} — {record.slots.normal.text.slice(0,100)||'Attachments'}</span>
      <button type="button" disabled={Boolean(composer.operation)||Boolean(Object.keys(record.operations).length)} onClick={()=>void botComposers.restoreDraft(owner,record.botId,composer.botId).then(restored=>{if(restored)setRecords(rows=>rows.filter(row=>row.botId!==record.botId));}).catch(()=>setError('Could not restore this draft. Its original is retained.'))}>{Object.keys(record.operations).length?'Awaiting send confirmation':'Restore'}</button></div>)}
    {composer.recoveries.map(slot=><div key={slot}><span>{composer.record.slots[slot].text.slice(0,100)||'Attachments'}</span><button type="button" disabled={Boolean(composer.operation)||Boolean(composer.record.slots[slot].queueSource&&!composer.record.slots[slot].queueSource?.removed)} onClick={()=>composer.select(slot)}>Restore</button></div>)}
    {!records.length&&!composer.recoveries.length&&<p>No earlier drafts.</p>}
  </details>;
}
