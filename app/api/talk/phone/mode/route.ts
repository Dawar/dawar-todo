import { env } from "cloudflare:workers";
import {
  authenticateTalkPhoneCall,
  readTalkPhoneCall,
  recordFailedTalkPhoneMode,
} from "../../../../../db/talk-phone";
import { beginTalkPhoneRecording } from "../../../../../db/talk-phone-recordings";
import {
  phoneModePromptTwiml,
  phoneRecordingTwiml,
  phoneRejectedTwiml,
  phoneSipTwiml,
  phoneStreamTwiml,
  talkPhoneMediaStreamUrl,
  talkPhoneTransport,
  twilioDocumentResponse,
  twilioPhoneConfig,
  validateTwilioRequest,
} from "../../../../../lib/twilio-phone";

function recordingTwiml(requestUrl: string, segmentIndex: number) {
  const actionUrl = new URL("/api/talk/phone/record/action", requestUrl);
  actionUrl.searchParams.set("segment", String(segmentIndex));
  const statusUrl = new URL("/api/talk/phone/record/status", requestUrl);
  statusUrl.searchParams.set("segment", String(segmentIndex));
  return phoneRecordingTwiml({
    actionUrl: actionUrl.toString(),
    statusUrl: statusUrl.toString(),
    playBeep: segmentIndex === 0,
  });
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  let callSid = "";
  try {
    const params = new URLSearchParams(await request.text());
    if (!await validateTwilioRequest(request, params)) {
      console.warn("[todo-talk-phone-api] mode webhook signature rejected");
      return twilioDocumentResponse(phoneRejectedTwiml(), 403);
    }
    const config = twilioPhoneConfig();
    callSid = params.get("CallSid")?.trim() ?? "";
    const accountSid = params.get("AccountSid")?.trim() ?? "";
    const call = await readTalkPhoneCall(callSid);
    if (!call?.user_key || accountSid !== config.accountSid || call.status !== "mode_pending") {
      console.warn("[todo-talk-phone-api] mode request did not match an authenticated call", {
        callSid,
        hasCall: Boolean(call),
        status: call?.status ?? null,
        accountMatched: accountSid === config.accountSid,
      });
      return twilioDocumentResponse(phoneRejectedTwiml(), 403);
    }
    const mode = (params.get("Digits") ?? "").trim();
    if (mode !== "1" && mode !== "2") {
      const failed = await recordFailedTalkPhoneMode(callSid);
      if (!failed.remainingAttempts) {
        return twilioDocumentResponse(phoneRejectedTwiml("No mode selected. Call ended."));
      }
      const actionUrl = new URL("/api/talk/phone/mode", request.url).toString();
      return twilioDocumentResponse(phoneModePromptTwiml({
        actionUrl,
        message: `Press 1 to talk. Press 2 to record. ${failed.remainingAttempts} ${failed.remainingAttempts === 1 ? "try" : "tries"} remaining.`,
      }));
    }
    if (mode === "2") {
      await beginTalkPhoneRecording(callSid, call.user_key);
      console.info("[todo-talk-phone-api] record mode response returned", {
        callSid,
        userKey: call.user_key,
        durationMs: Date.now() - startedAt,
      });
      return twilioDocumentResponse(recordingTwiml(request.url, 0));
    }
    const token = await authenticateTalkPhoneCall(callSid, call.user_key);
    const transport = talkPhoneTransport();
    if (transport === "sip") {
      const projectId = String((env as unknown as { OPENAI_PROJECT_ID?: string }).OPENAI_PROJECT_ID ?? "").trim();
      console.info("[todo-talk-phone-api] talk mode direct SIP response returned", {
        callSid,
        userKey: call.user_key,
        projectIdSuffix: projectId.slice(-8),
        durationMs: Date.now() - startedAt,
      });
      return twilioDocumentResponse(phoneSipTwiml({
        projectId,
        callSid,
        token: token.rawToken,
      }));
    }
    const streamUrl = talkPhoneMediaStreamUrl(request.url);
    console.info("[todo-talk-phone-api] talk mode stream response returned", {
      callSid,
      userKey: call.user_key,
      streamHost: new URL(streamUrl).host,
      durationMs: Date.now() - startedAt,
    });
    return twilioDocumentResponse(phoneStreamTwiml({
      streamUrl,
      token: token.rawToken,
    }));
  } catch (error) {
    console.error("[todo-talk-phone-api] mode selection failed", {
      callSid,
      durationMs: Date.now() - startedAt,
      error,
    });
    return twilioDocumentResponse(phoneRejectedTwiml("Phone access is temporarily unavailable."));
  }
}
