// Shared names only. Importing this protocol never constructs a runtime,
// opens a database or grants browser access to internal dispatch commands.
export const roomDeliverySource=d=>({id:d.id,botId:d.botId,roomId:d.roomId,postId:d.postId,contextId:d.contextId,clientId:d.clientId,expectedTurnId:d.expectedTurnId??null,createdAt:d.createdAt,membershipRevision:d.membershipRevision,membersSnapshot:d.membersSnapshot,operationId:d.operationId,answerKey:d.answerKey??null});
export const HUB_BURST_MUTATIONS=new Set(['bursts.submit','bursts.start','bursts.resume','bursts.stop','bursts.discard','bursts.queue']);
export const HUB_ROOM_READS=new Set(['conversations.list','conversations.read','conversations.contexts','collaboration.results']);
export const HUB_ROOM_MUTATIONS=new Set(['conversations.create','conversations.post','conversations.membership','conversations.hold']);
// Current registered native callers may use these canonical hub records.
// Membership/hold remain human controls. Native bodies/resources stay local.
export const HUB_ROOM_TOOL_METHODS=new Set([...HUB_ROOM_READS,'conversations.create','conversations.post','collaboration.result']);
export const LOCAL_ROOM_TOOL_METHODS=new Set(['execution.config','conversations.history','conversations.detail','conversations.log','collaboration.resourceAcquire','collaboration.resourceRelease']);
export const ROOM_NATIVE_READS=new Set(['conversations.history','conversations.detail','conversations.log','conversations.requests']);
export const ROOM_QUESTION_LOOKUP=Symbol('original-room-question-lookup');
export const roomQuestionSource=p=>({id:p.id,key:p.key,botId:p.botId,roomId:p.roomId,contextId:p.contextId,threadId:p.threadId,turnId:p.turnId,async:p.async??false,epoch:p.epoch??null,request:p.request,createdAt:p.createdAt});
export const HUB_READS=new Set(['queue.list','queueLists.list','schedules.list','runs.page','bursts.read','bursts.typing',...HUB_ROOM_READS]);
export const HUB_MUTATIONS=new Set(['queue.add','queue.update','queue.delete','queue.reorder','queue.move','queue.merge','queue.send','queue.resume','work.resume','queueLists.save','queueLists.delete','queueLists.flush','schedules.save','schedules.delete','schedules.run','conversations.respond',...HUB_BURST_MUTATIONS,...HUB_ROOM_MUTATIONS]);
export const HUB_TOOLS=new Set(['bots_queue','bots_schedule_list','bots_schedule_save','bots_schedule_delete']);
export const NODE_LOGICAL_COMMANDS=new Set(['portable.queueDispatch','portable.scheduleDispatch','portable.queueSend','portable.queueResume','portable.burstDispatch','portable.roomDispatch']);
