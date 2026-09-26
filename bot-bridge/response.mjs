// Shared by the service and integration tests. Do not infer certainty from text.
export async function bridgeResponse(runtime, request) {
  try {
    return { type: "response", clientId: request.clientId, id: request.id,
      result: await runtime.handle(request) };
  } catch (error) {
    return { type: "response", clientId: request.clientId, id: request.id,
      error: error.message ?? "The bridge could not confirm the operation.",
      outcome: error.outcome === "rejected" ? "rejected" : "uncertain" };
  }
}
