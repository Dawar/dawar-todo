import { waitUntil } from "cloudflare:workers";
import { readTalkPhoneCall } from "../../../../../../db/talk-phone";
import {
  processTalkPhoneRecordingQueue,
  recordTalkPhoneSegmentStatus,
} from "../../../../../../db/talk-phone-recordings";
import {
  phoneRejectedTwiml,
  twilioDocumentResponse,
  twilioPhoneConfig,
  twilioXmlResponse,
  validateTwilioRequest,
} from "../../../../../../lib/twilio-phone";

function segmentIndex(request: Request) {
  const value = Number(new URL(request.url).searchParams.get("segment"));
  return Number.isInteger(value) && value >= 0 && value < 8 ? value : null;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  let callSid = "";
  try {
    const params = new URLSearchParams(await request.text());
    if (!await validateTwilioRequest(request, params)) {
      console.warn("[todo-talk-phone-recording-api] status signature rejected");
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
      || !["recording", "processing", "completed"].includes(call.status)
      || accountSid !== config.accountSid
    ) {
      console.warn("[todo-talk-phone-recording-api] status metadata rejected", {
        callSid,
        segmentIndex: index,
        hasCall: Boolean(call),
        mode: call?.mode ?? null,
        status: call?.status ?? null,
        accountMatched: accountSid === config.accountSid,
      });
      return twilioDocumentResponse(phoneRejectedTwiml(), 403);
    }
    await recordTalkPhoneSegmentStatus({
      callSid,
      segmentIndex: index,
      recordingSid: params.get("RecordingSid")?.trim() ?? "",
      status: params.get("RecordingStatus")?.trim().toLowerCase() ?? "",
      durationSeconds: params.get("RecordingDuration"),
    });
    waitUntil(processTalkPhoneRecordingQueue(new Date(), callSid).catch((error) => {
      console.error("[todo-talk-phone-recording-api] status processing handoff failed", { callSid, error });
    }));
    console.info("[todo-talk-phone-recording-api] status callback accepted", {
      callSid,
      segmentIndex: index,
      recordingStatus: params.get("RecordingStatus")?.trim().toLowerCase() ?? null,
      durationMs: Date.now() - startedAt,
    });
    return twilioXmlResponse("");
  } catch (error) {
    console.error("[todo-talk-phone-recording-api] status callback failed", {
      callSid,
      durationMs: Date.now() - startedAt,
      error,
    });
    return twilioXmlResponse("", 500);
  }
}
