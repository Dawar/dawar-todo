export type VoiceBinding={sourceId:string;installationId:string;producerSHA256:string};
export function createVoiceMigrationLedger(storage:DurableObjectStorage,original:VoiceBinding):{command(input:{binding:VoiceBinding;action:string;args:Record<string,unknown>}):Promise<Record<string,unknown>>};
