"use client";
import { useSyncExternalStore } from 'react';
import { botsClient } from './client';
import { BotAvatar } from './bot-avatar';
import type { SubmissionSource } from '../../lib/submission-source';

export function SubmissionAuthor({source}:{source:SubmissionSource}){
  const snapshot=useSyncExternalStore(botsClient.subscribe,()=>botsClient.snapshot,()=>null);
  const bot=source.kind==='bot'?snapshot?.bots.find(b=>b.id===source.id):null;
  const name=source.kind==='unknown'?'Unknown sender':source.name;
  const initials=name.trim().split(/\s+/).slice(0,2).map(x=>Array.from(x)[0]??'').join('').toUpperCase();
  return <span className="bots-submission-author">
    {bot?.avatar?<BotAvatar bot={bot} small working={false} decorative/>:<span className="bots-submission-initials" aria-hidden="true">{source.kind==='unknown'?'?':initials}</span>}
    <span>{name}</span>
  </span>;
}
