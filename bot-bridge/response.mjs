// Shared by the service and integration tests. Do not infer certainty from text.
export async function bridgeResponse(runtime, request) {
  try {
    return { type: "response", clientId: request.clientId, id: request.id,
      result: await runtime.handle(request) };
  } catch (error) {
    const outcome = error?.outcome === "rejected" ? "rejected" : "uncertain";
    const detail = typeof error?.message === "string" && error.message
      ? error.message : "The bridge could not confirm the operation.";
    // sendLarge chunks only result for oversized replies. Keep failures in one
    // frame so both error and certainty survive old relay/client envelopes.
    const text = detail.length > 32000 ? `${detail.slice(0, 32000)}… [error truncated]` : detail;
    return { type: "response", clientId: request.clientId, id: request.id,
      error: text, outcome,
      result: { __dawarBotFailure: { version: 1, operationId: request.operationId, outcome } } };
  }
}
