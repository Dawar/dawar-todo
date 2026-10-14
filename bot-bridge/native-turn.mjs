// The checked-in v2 Turn/TurnStatus and TurnSteerResponse contracts. Do not
// normalize/fabricate an identity or interpret unknown statuses as completion.
export const usableTurnId = id => typeof id === "string" && id.length > 0 && id.trim() === id;
export const usableTurn = turn => usableTurnId(turn?.id) &&
  ["inProgress", "completed", "failed", "interrupted"].includes(turn?.status);
export const terminalTurn = turn => usableTurn(turn) && turn.status !== "inProgress";

export function requireTurn(turn) {
  if (!usableTurn(turn)) throw new Error("Native turn acknowledgement has no usable identity/status. Its execution remains unconfirmed; it was not replayed.");
  return turn;
}

export function requireSteer(result, expectedTurnId) {
  if (!usableTurnId(result?.turnId) || result.turnId !== expectedTurnId)
    throw new Error("Native answer acknowledgement has no matching turn identity. Its execution remains unconfirmed; it was not replayed.");
  return result;
}
