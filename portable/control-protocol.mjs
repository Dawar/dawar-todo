// Shared logical controls; importing this module grants no native authority.
import { TEAM_READS, TEAM_MUTATIONS } from './hub-teams.mjs';
export const HUB_BURST_MUTATIONS=new Set(['bursts.submit','bursts.start','bursts.resume','bursts.stop','bursts.discard','bursts.queue','bursts.checkout','bursts.checkoutCommit']);
export const HUB_READS=new Set(['initiative.read','submissions.source','queue.list','queueLists.list','schedules.list','runs.page','bursts.read','bursts.typing','bursts.checkoutRead','inbox.list',...TEAM_READS]);
export const HUB_MUTATIONS=new Set(['initiative.configure','initiative.thread','bots.read','queue.add','queue.update','queue.delete','queue.reorder','queue.move','queue.merge','queue.send','queue.resume','work.resume','queueLists.save','queueLists.delete','queueLists.flush','schedules.save','schedules.delete','schedules.run',...HUB_BURST_MUTATIONS,...TEAM_MUTATIONS]);
export const HUB_TOOLS=new Set(['bots_initiative','bots_message','bots_team','bots_queue','bots_schedule_list','bots_schedule_save','bots_schedule_delete']);
export const NODE_LOGICAL_COMMANDS=new Set(['portable.queueDispatch','portable.scheduleDispatch','portable.queueSend','portable.queueResume','portable.burstDispatch','portable.primaryDispatch']);
