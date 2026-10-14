// Shared metadata contract. No file names, URLs, tokens or content in responses.
export type AttachmentRecovery = {
  targetExists: boolean;
  imageProcessingAvailable?: boolean;
  files: Array<{
    id: string;
    state: "missing" | "deleted" | "draft" | "uploading" | "ready";
    todoId: number | null;
  }>;
};
