export const SOURCE_CONTROL_PATH: string;
export type DatabaseCopyBinding = {
  sourceId: string;
  operationId: string;
  schemaSHA256: string;
  recentTailLossAccepted: boolean;
};
export function createOriginalSourceControl(options: {
  db: unknown;
  configuration: unknown;
  build: string;
  authorizeOwner: (request: Request) => unknown | Promise<unknown>;
  admissionEnabled?: boolean;
  databaseCopy?: DatabaseCopyBinding | null;
}): {fetch(request: Request): Promise<Response>};
