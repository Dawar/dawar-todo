import { readUrgentAlertAttemptContext } from "../../../../../../../db/urgent-alerts";
import {
  twilioPhoneConfig,
  twilioXmlResponse,
  validateTwilioRequest,
  xmlEscape,
} from "../../../../../../../lib/twilio-phone";

function compact(value: string, maximum: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

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
    if (!["pending", "awaiting_ack", "blocked_configuration"].includes(context.state)) {
      return twilioXmlResponse("<Say>This urgent task has already been handled.</Say><Hangup/>");
    }
    const answeredBy = params.get("AnsweredBy")?.trim().toLowerCase() ?? "";
    const task = xmlEscape(compact(context.title, 320));
    const agent = xmlEscape(compact(context.source_agent_name, 60));
    if (answeredBy.startsWith("machine") || answeredBy === "fax") {
      return twilioXmlResponse(`<Say>Dawar Todo urgent alert from ${agent}. ${task}. A text with acknowledgement instructions was also sent.</Say><Hangup/>`);
    }
    const actionUrl = new URL("/api/talk/phone/urgent/provider/voice/action", request.url);
    actionUrl.searchParams.set("attempt", attemptId);
    return twilioXmlResponse(
      `<Gather input="dtmf" action="${xmlEscape(actionUrl.toString())}" method="POST" numDigits="1" timeout="12" actionOnEmptyResult="true">`
        + `<Say>Dawar Todo urgent alert from ${agent}. ${task}. Press 1 to acknowledge, 2 to pin, 3 to snooze for one hour, 4 to mark done, or 9 to repeat.</Say>`
        + `</Gather><Redirect method="POST">${xmlEscape(actionUrl.toString())}</Redirect>`,
    );
  } catch (error) {
    console.error("[todo-urgent-alert] voice instructions failed", { error });
    return twilioXmlResponse("<Say>Dawar Todo is temporarily unavailable.</Say><Hangup/>");
  }
}
