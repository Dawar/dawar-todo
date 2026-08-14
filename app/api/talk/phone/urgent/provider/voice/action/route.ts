import { applyUrgentAlertAction, readUrgentAlertAttemptContext } from "../../../../../../../../db/urgent-alerts";
import { twilioPhoneConfig, twilioXmlResponse, validateTwilioRequest, xmlEscape } from "../../../../../../../../lib/twilio-phone";

export async function POST(request: Request) {
  try {
    const params = new URLSearchParams(await request.text());
    if (!await validateTwilioRequest(request, params)) return twilioXmlResponse("<Say>Access denied.</Say>", 403);
    if (params.get("AccountSid")?.trim() !== twilioPhoneConfig().accountSid) return twilioXmlResponse("<Say>Access denied.</Say>", 403);
    const attemptId = new URL(request.url).searchParams.get("attempt") ?? "";
    const context = await readUrgentAlertAttemptContext(attemptId);
    const callSid = params.get("CallSid")?.trim() ?? "";
    if (!context || context.channel !== "voice" || (context.provider_sid && context.provider_sid !== callSid)) {
      return twilioXmlResponse("<Say>This urgent alert is unavailable.</Say><Hangup/>", 404);
    }
    const digit = params.get("Digits")?.trim() ?? "";
    if (digit === "9" || !digit) {
      const repeatUrl = new URL("/api/talk/phone/urgent/provider/voice", request.url);
      repeatUrl.searchParams.set("attempt", attemptId);
      return twilioXmlResponse(`<Redirect method="POST">${xmlEscape(repeatUrl.toString())}</Redirect>`);
    }
    const action = digit === "1" ? "ack" : digit === "2" ? "pin" : digit === "3" ? "snooze" : digit === "4" ? "done" : null;
    if (!action) return twilioXmlResponse("<Say>That option is invalid.</Say><Hangup/>");
    const result = await applyUrgentAlertAction({ escalationId: context.escalation_id, action, channel: "voice" });
    const message = !result.applied && "reason" in result && result.reason === "pin-limit"
      ? "Five tasks are already pinned. Use Dawar Todo, or choose another action from the text message."
      : result.applied
      ? action === "ack" ? "Urgent alert acknowledged." : action === "pin" ? "Task pinned." : action === "snooze" ? "Task snoozed for one hour." : "Task marked done."
      : "This urgent task was already handled.";
    return twilioXmlResponse(`<Say>${xmlEscape(message)}</Say><Hangup/>`);
  } catch (error) {
    console.error("[todo-urgent-alert] voice action failed", { error });
    return twilioXmlResponse("<Say>The action could not be completed. Use Dawar Todo or reply to the text.</Say><Hangup/>");
  }
}
