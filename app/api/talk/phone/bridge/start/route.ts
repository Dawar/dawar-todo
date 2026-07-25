import {
  attachTalkSessionToPhoneCall,
  consumeTalkPhoneStream,
} from "../../../../../../db/talk-phone";
import {
  chooseTalkFocus,
  heartbeatTalkSession,
  readTalkWorkspace,
  startTalkSession,
} from "../../../../../../db/talk";
import { listTodos } from "../../../../../../db/todos";
import { buildSharedAssistantContext } from "../../../../../../lib/assistant-context";
import {
  phoneBridgeError,
  phoneBridgeHeaders,
  talkPhoneBridgeToken,
} from "../../../../../../lib/talk-phone-bridge";
import {
  hashedSafetyIdentifier,
  mintRealtimeClientSecret,
  talkInstructions,
  talkRuntimeConfig,
} from "../../../../../../lib/talk-runtime";
import { twilioPhoneConfig } from "../../../../../../lib/twilio-phone";

type StartPayload = {
  accountSid?: unknown;
  callSid?: unknown;
  mediaFormat?: {
    encoding?: unknown;
    sampleRate?: unknown;
    channels?: unknown;
  };
};

export async function POST(request: Request) {
  const startedAt = Date.now();
  let callSid = "";
  let talkSessionId = "";
  try {
    const rawToken = talkPhoneBridgeToken(request);
    const payload = await request.json() as StartPayload;
    callSid = String(payload.callSid ?? "").trim();
    const accountSid = String(payload.accountSid ?? "").trim();
    const config = twilioPhoneConfig();
    if (!rawToken || accountSid !== config.accountSid) {
      throw new Error("The phone relay request was rejected.");
    }
    if (
      payload.mediaFormat?.encoding !== "audio/x-mulaw"
      || Number(payload.mediaFormat.sampleRate) !== 8_000
      || Number(payload.mediaFormat.channels) !== 1
    ) {
      throw new Error("Twilio supplied an unsupported audio format.");
    }

    const authenticated = await consumeTalkPhoneStream({ callSid, rawToken });
    if (!authenticated) throw new Error("The phone stream token is invalid or expired.");
    const userKey = authenticated.userKey;
    const [todos, workspace] = await Promise.all([
      listTodos(),
      readTalkWorkspace(userKey),
    ]);
    const focusedTodoId = chooseTalkFocus(todos, workspace.lastFocusedTodoId);
    const { model, voice } = talkRuntimeConfig();

    if (authenticated.talkSessionId) {
      try {
        await heartbeatTalkSession(userKey, authenticated.talkSessionId, focusedTodoId);
        talkSessionId = authenticated.talkSessionId;
      } catch {
        talkSessionId = "";
      }
    }
    if (!talkSessionId) {
      const session = await startTalkSession({ userKey, model, voice, focusedTodoId });
      talkSessionId = session.id;
      await attachTalkSessionToPhoneCall(callSid, talkSessionId);
    }

    const [context, safetyIdentifier] = await Promise.all([
      buildSharedAssistantContext(userKey, focusedTodoId),
      hashedSafetyIdentifier(userKey),
    ]);
    const secret = await mintRealtimeClientSecret({
      safetyIdentifier,
      instructions: talkInstructions(context),
      audioFormat: "pcmu",
    });
    console.info("[todo-talk-phone-bridge] relay session started", {
      callSid,
      talkSessionId,
      focusedTodoId,
      model: secret.model,
      voice: secret.voice,
      replayedStreamStart: authenticated.replayed,
      taskCount: context.tasks.length,
      memoryCount: context.memories.length,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({
      talkSessionId,
      clientSecret: secret.value,
      expiresAt: secret.expiresAt,
      model: secret.model,
      voice: secret.voice,
      focusedTodoId,
    }, { headers: phoneBridgeHeaders });
  } catch (error) {
    console.error("[todo-talk-phone-bridge] relay session start failed", {
      callSid: callSid || null,
      talkSessionId: talkSessionId || null,
      durationMs: Date.now() - startedAt,
      error,
    });
    return phoneBridgeError(error, "The phone relay could not start.");
  }
}
