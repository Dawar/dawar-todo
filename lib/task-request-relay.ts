import { secureBrowserFrame } from './secure-relay';
import type { TaskRequestTicket } from './bots-auth';

/** Guest frames get their scope exclusively from the signed, non-owner ticket. */
export function taskRequestFrame(message:Record<string,unknown>,ticket:TaskRequestTicket,clientId:string) {
  const id=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,180}$/.test(v);
  if(!id(message.id)||!['create','key','chunk','status','delete'].includes(String(message.action)))throw Error('Invalid private form frame.');
  const base={type:'task-request',id:message.id,action:message.action,owner:ticket.owner,botId:ticket.botId,threadId:ticket.threadId,binding:ticket.binding,clientId};
  if(message.action==='create')return base;
  const frame=secureBrowserFrame({...message,botId:ticket.botId,threadId:ticket.threadId},ticket.owner,clientId);
  if(message.action==='chunk'&&message.submissionId!==ticket.binding.submissionId)throw Error('Private submission identity changed.');
  return {...frame,...base};
}
