import { waitUntil } from "cloudflare:workers";
import { readTalkPhoneCall } from "../../../../../../db/talk-phone";
import {
  processTalkPhoneRecordingQueue,
  recordTalkPhoneSegmentAction,
} from "../../../../../../db/talk-phone-recordings";
import {
  phoneRecordingTwiml,
  phoneRejectedTwiml,
  twilioDocumentResponse,
  twilioPhoneConfig,
  twilioXmlResponse,
  validateTwilioRequest,
  validTwilioRecordingSid,
} from "../../../../../../lib/twilio-phone";

function segmentIndex(request: Request) {
  const value = Number(new URL(request.url).searchParams.get("segment"));
  return Number.isInteger(value) && value >= 0 && value < 8 ? value : null;
}

function nextRecordingTwiml(requestUrl: string, index: number) {
  const actionUrl = new URL("/api/talk/phone/record/action", requestUrl);
  actionUrl.searchParams.set("segment", String(index));
  const statusUrl = new URL("/api/talk/phone/record/status", requestUrl);
  statusUrl.searchParams.set("segment", String(index));
  return phoneRecordingTwiml({
    actionUrl: actionUrl.toString(),
    statusUrl: statusUrl.toString(),
    playBeep: false,
  });
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  let callSid = "";
  try {
    const params = new URLSearchParams(await request.text());
    if (!await validateTwilioRequest(request, params)) {
      console.warn("[todo-talk-phone-recording-api] action signature rejected");
      return twilioDocumentResponse(phoneRejectedTwiml(), 403);
    }
    const index = segmentIndex(request);
    const config = twilioPhoneConfig();
    callSid = params.get("CallSid")?.trim() ?? "";
    const accountSid = params.get("AccountSid")?.trim() ?? "";
    const call = await readTalkPhoneCall(callSid);
    if (
      index === null
      || !call?.user_key
      || call.mode !== "record"
      || !["recording", "processing"].includes(call.status)
      || accountSid !== config.accountSid
    ) {
      console.warn("[todo-talk-phone-recording-api] action metadata rejected", {
        callSid,
        segmentIndex: index,
        hasCall: Boolean(call),
        mode: call?.mode ?? null,
        status: call?.status ?? null,
        accountMatched: accountSid === config.accountSid,
      });
      return twilioDocumentResponse(phoneRejectedTwiml(), 403);
    }
    const suppliedRecordingSid = params.get("RecordingSid")?.trim() ?? "";
    const recordingSid = validTwilioRecordingSid(suppliedRecordingSid) ? suppliedRecordingSid : null;
    const digits = params.get("Digits")?.trim().toLowerCase() ?? "";
    const reason = digits === "hangup" || params.get("CallStatus") === "completed" ? "hangup" : digits || null;
    const result = await recordTalkPhoneSegmentAction({
      callSid,
      segmentIndex: index,
      recordingSid,
      durationSeconds: params.get("RecordingDuration"),
      reason,
    });
    if (result.finalSegment) {
      waitUntil(processTalkPhoneRecordingQueue(new Date(), callSid).catch((error) => {
        console.error("[todo-talk-phone-recording-api] final action processing handoff failed", { callSid, error });
      }));
      console.info("[todo-talk-phone-recording-api] recording finalized", {
        callSid,
        segmentIndex: index,
        durationMs: Date.now() - startedAt,
      });
      return twilioXmlResponse("<Hangup/>");
    }
    console.info("[todo-talk-phone-recording-api] next recording segment returned", {
      callSid,
      segmentIndex: result.nextSegmentIndex,
      durationMs: Date.now() - startedAt,
    });
    return twilioDocumentResponse(nextRecordingTwiml(request.url, result.nextSegmentIndex));
  } catch (error) {
    console.error("[todo-talk-phone-recording-api] recording action failed", {
      callSid,
      durationMs: Date.now() - startedAt,
      error,
    });
    return twilioDocumentResponse(phoneRejectedTwiml("The recording could not continue."));
  }
}
