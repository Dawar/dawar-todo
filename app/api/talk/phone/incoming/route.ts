import {
  beginTalkPhoneCall,
  hasEnabledTalkPhoneProfile,
} from "../../../../../db/talk-phone";
import {
  phonePinPromptTwiml,
  phoneRejectedTwiml,
  phoneUnavailableTwiml,
  twilioDocumentResponse,
  twilioPhoneConfig,
  validateTwilioRequest,
} from "../../../../../lib/twilio-phone";

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const params = new URLSearchParams(await request.text());
    if (!await validateTwilioRequest(request, params)) {
      console.warn("[todo-talk-phone-api] inbound webhook signature rejected");
      return twilioDocumentResponse(phoneRejectedTwiml(), 403);
    }
    const config = twilioPhoneConfig();
    const accountSid = params.get("AccountSid")?.trim() ?? "";
    const callSid = params.get("CallSid")?.trim() ?? "";
    const fromNumber = params.get("From")?.trim() ?? "";
    const toNumber = params.get("To")?.trim() ?? "";
    if (!accountSid || accountSid !== config.accountSid || toNumber !== config.phoneNumber) {
      console.warn("[todo-talk-phone-api] inbound call metadata rejected", {
        callSid,
        accountMatched: accountSid === config.accountSid,
        destinationMatched: toNumber === config.phoneNumber,
      });
      return twilioDocumentResponse(phoneRejectedTwiml(), 403);
    }
    if (!await hasEnabledTalkPhoneProfile()) {
      console.warn("[todo-talk-phone-api] inbound call rejected because no phone PIN is enabled", { callSid });
      return twilioDocumentResponse(phoneUnavailableTwiml());
    }
    const call = await beginTalkPhoneCall({ callSid, fromNumber, toNumber });
    if (call.blocked) {
      return twilioDocumentResponse(phoneRejectedTwiml("Too many failed calls. Try again later."));
    }
    const verifyUrl = new URL("/api/talk/phone/verify", request.url).toString();
    console.info("[todo-talk-phone-api] PIN prompt returned", {
      callSid,
      durationMs: Date.now() - startedAt,
    });
    return twilioDocumentResponse(phonePinPromptTwiml({ actionUrl: verifyUrl }));
  } catch (error) {
    console.error("[todo-talk-phone-api] inbound call setup failed", {
      durationMs: Date.now() - startedAt,
      error,
    });
    return twilioDocumentResponse(phoneRejectedTwiml("Phone access is temporarily unavailable."));
  }
}
