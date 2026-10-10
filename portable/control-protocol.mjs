// Shared names only. Importing this protocol never constructs a runtime,
// opens a database or grants browser access to internal dispatch commands.
export const HUB_READS=new Set(['queue.list','queueLists.list','schedules.list','runs.page']);
export const HUB_MUTATIONS=new Set(['queue.add','queue.update','queue.delete','queue.reorder','queue.move','queue.merge','queue.send','queue.resume','work.resume','queueLists.save','queueLists.delete','queueLists.flush','schedules.save','schedules.delete','schedules.run']);
export const HUB_TOOLS=new Set(['bots_queue','bots_schedule_list','bots_schedule_save','bots_schedule_delete']);
export const NODE_LOGICAL_COMMANDS=new Set(['portable.queueDispatch','portable.scheduleDispatch','portable.queueSend','portable.queueResume']);
