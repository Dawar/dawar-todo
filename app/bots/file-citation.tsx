"use client";
import {FileText,ArrowUpRight,FileQuestion} from 'lucide-react';
import type {BotAttachment} from '../../lib/bots-types';
import {readFileCitation} from '../../lib/file-citation.mjs';
import {ReturnedArtifact} from './returned-artifact';
import './file-citation.css';
export function FileCitation({botId,reference,attachments}:{botId:string;reference:string;attachments:BotAttachment[]}){
  const citation=readFileCitation(reference);if(!citation)return <span>File reference unavailable</span>;
  const {path,purpose}=citation;
  if(/^https?:/i.test(path)){
    const url=new URL(path),google=url.hostname==='docs.google.com',kind=google?(url.pathname.startsWith('/spreadsheets/')?'Google spreadsheet':url.pathname.startsWith('/presentation/')?'Google presentation':'Google document'):null;
    let title=kind??url.pathname.split('/').filter(Boolean).at(-1)??url.hostname;try{title=decodeURIComponent(title);}catch{/* Literal name remains readable. */}
    return <a className="bots-file-citation" href={url.href} target="_blank" rel="noopener noreferrer" aria-label={`Open ${title}`}>
      <FileText size={22} strokeWidth={1.5} aria-hidden="true"/><span><strong>{title}</strong><small>{url.hostname}</small></span><ArrowUpRight size={16} aria-hidden="true"/>
    </a>;
  }
  const matches=attachments.filter(file=>file.botId===botId&&file.ready&&(purpose==='input'||purpose==='source'||file.artifact||file.direction==='output')&&(file.path===path||file.visualizationReferences?.includes(path)));
  if(matches.length===1)return <ReturnedArtifact botId={botId} id={matches[0].id} attachment={matches[0]} preview={purpose!=='source'}/>;
  return <span className="bots-file-citation is-unavailable"><FileQuestion size={22} strokeWidth={1.5} aria-hidden="true"/><span><strong>{path.split('/').at(-1)||'File'}</strong><small>File unavailable</small></span></span>;
}
