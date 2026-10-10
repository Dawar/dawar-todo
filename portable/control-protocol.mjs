// Shared names only. Importing this protocol never constructs a runtime,
// opens a database or grants browser access to internal dispatch commands.
export const HUB_BURST_MUTATIONS=new Set(['bursts.submit','bursts.start','bursts.resume','bursts.stop','bursts.discard','bursts.queue']);
export const HUB_ROOM_READS=new Set(['conversations.list','conversations.read','collaboration.results']);
export const HUB_ROOM_MUTATIONS=new Set(['conversations.create','conversations.post','conversations.membership','conversations.hold']);
export const HUB_READS=new Set(['queue.list','queueLists.list','schedules.list','runs.page','bursts.read','bursts.typing',...HUB_ROOM_READS]);
export const HUB_MUTATIONS=new Set(['queue.add','queue.update','queue.delete','queue.reorder','queue.move','queue.merge','queue.send','queue.resume','work.resume','queueLists.save','queueLists.delete','queueLists.flush','schedules.save','schedules.delete','schedules.run',...HUB_BURST_MUTATIONS,...HUB_ROOM_MUTATIONS]);
export const HUB_TOOLS=new Set(['bots_queue','bots_schedule_list','bots_schedule_save','bots_schedule_delete']);
export const NODE_LOGICAL_COMMANDS=new Set(['portable.queueDispatch','portable.scheduleDispatch','portable.queueSend','portable.queueResume','portable.burstDispatch']);
