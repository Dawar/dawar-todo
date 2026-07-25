import {
  authenticateTalkPhoneCall,
  findTalkPhoneUserByPin,
  readTalkPhoneCall,
  recordFailedTalkPhonePin,
} from "../../../../../db/talk-phone";
import {
  phonePinPromptTwiml,
  phoneRejectedTwiml,
  phoneSipTwiml,
  phoneStreamTwiml,
  talkPhoneTransport,
  talkPhoneMediaStreamUrl,
  twilioDocumentResponse,
  twilioPhoneConfig,
  validateTwilioRequest,
} from "../../../../../lib/twilio-phone";
import { env } from "cloudflare:workers";

export async function POST(request: Request) {
  const startedAt = Date.now();
  let callSid = "";
  try {
    const params = new URLSearchParams(await request.text());
    if (!await validateTwilioRequest(request, params)) {
      console.warn("[todo-talk-phone-api] PIN webhook signature rejected");
      return twilioDocumentResponse(phoneRejectedTwiml(), 403);
    }
    const config = twilioPhoneConfig();
    callSid = params.get("CallSid")?.trim() ?? "";
    const accountSid = params.get("AccountSid")?.trim() ?? "";
    const call = await readTalkPhoneCall(callSid);
    if (!call || accountSid !== config.accountSid || call.status !== "pin_pending") {
      console.warn("[todo-talk-phone-api] PIN request did not match an active call", {
        callSid,
        hasCall: Boolean(call),
        status: call?.status ?? null,
        accountMatched: accountSid === config.accountSid,
      });
      return twilioDocumentResponse(phoneRejectedTwiml(), 403);
    }
    const pin = (params.get("Digits") ?? "").replace(/\D/g, "").slice(0, 8);
    const userKey = await findTalkPhoneUserByPin(pin);
    if (!userKey) {
      const failed = await recordFailedTalkPhonePin(callSid);
      if (!failed.remainingAttempts) {
        return twilioDocumentResponse(phoneRejectedTwiml("PIN not accepted. Call ended."));
      }
      const actionUrl = new URL("/api/talk/phone/verify", request.url).toString();
      return twilioDocumentResponse(phonePinPromptTwiml({
        actionUrl,
        message: `PIN not accepted. ${failed.remainingAttempts} ${failed.remainingAttempts === 1 ? "try" : "tries"} remaining. Enter your PIN, then press pound.`,
      }));
    }
    const token = await authenticateTalkPhoneCall(callSid, userKey);
    const transport = talkPhoneTransport();
    if (transport === "sip") {
      const projectId = String((env as unknown as { OPENAI_PROJECT_ID?: string }).OPENAI_PROJECT_ID ?? "").trim();
      console.info("[todo-talk-phone-api] authenticated direct SIP response returned", {
        callSid,
        userKey,
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
    console.info("[todo-talk-phone-api] authenticated stream response returned", {
      callSid,
      userKey,
      streamHost: new URL(streamUrl).host,
      durationMs: Date.now() - startedAt,
    });
    return twilioDocumentResponse(phoneStreamTwiml({
      streamUrl,
      token: token.rawToken,
    }));
  } catch (error) {
    console.error("[todo-talk-phone-api] PIN verification failed", {
      callSid,
      durationMs: Date.now() - startedAt,
      error,
    });
    return twilioDocumentResponse(phoneRejectedTwiml("Phone access is temporarily unavailable."));
  }
}
