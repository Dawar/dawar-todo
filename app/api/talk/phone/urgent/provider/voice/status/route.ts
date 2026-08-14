import { recordUrgentAttemptStatus } from "../../../../../../../../db/urgent-alerts";
import { twilioPhoneConfig, twilioXmlResponse, validateTwilioRequest } from "../../../../../../../../lib/twilio-phone";

export async function POST(request: Request) {
  try {
    const params = new URLSearchParams(await request.text());
    if (!await validateTwilioRequest(request, params)) return twilioXmlResponse("", 403);
    if (params.get("AccountSid")?.trim() !== twilioPhoneConfig().accountSid) return twilioXmlResponse("", 403);
    const attemptId = new URL(request.url).searchParams.get("attempt") ?? "";
    const providerSid = params.get("CallSid")?.trim() ?? "";
    const status = params.get("CallStatus")?.trim() ?? "unknown";
    if (!providerSid) return twilioXmlResponse("", 400);
    await recordUrgentAttemptStatus({
      attemptId,
      channel: "voice",
      providerSid,
      status,
      providerErrorCode: params.get("ErrorCode")?.trim() || null,
    });
    return twilioXmlResponse("");
  } catch (error) {
    console.error("[todo-urgent-alert] voice status callback failed", { error });
    return twilioXmlResponse("", 500);
  }
}
