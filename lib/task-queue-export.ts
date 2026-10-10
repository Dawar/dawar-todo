/** Normal owner task files only. No signed URLs, storage keys or guest/secure fields. */
export type TaskQueueSourceFile = { id:string; name:string; size:number; mimeType:string; updatedAt:string; sortOrder:number };
export type TaskQueueSource = { todoId:number; revision:string; updatedAt:string; title:string; notes:string; files:TaskQueueSourceFile[] };
export type TaskQueueExportInput = { operationId:string; botId:string; sourceRevision:string };
export type TaskQueueExportFile = { sourceAttachmentId:string; attachmentId:string; name:string; size:number; mimeType:string; sha256:string };
export type TaskQueueExportReceipt = { version:1; taskExportId:string; operationId:string; botId:string; source:TaskQueueSource;
  files:TaskQueueExportFile[]; state:"ready"; createdAt:string; readyAt:string };
/** Before new queue acceptance require sourceCurrent=true. Reconciliation never re-adds accepted work. */
export type TaskQueueExportResolution = { receipt:TaskQueueExportReceipt; sourceCurrent:boolean };
