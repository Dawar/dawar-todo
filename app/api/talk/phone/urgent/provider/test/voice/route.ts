import { twilioPhoneConfig, twilioXmlResponse, validateTwilioRequest } from "../../../../../../../../lib/twilio-phone";

export async function POST(request: Request) {
  const params = new URLSearchParams(await request.text());
  if (!await validateTwilioRequest(request, params)) return twilioXmlResponse("", 403);
  if (params.get("AccountSid")?.trim() !== twilioPhoneConfig().accountSid) return twilioXmlResponse("", 403);
  return twilioXmlResponse("<Say>Dawar Todo test. Your verified profile phone is ready for urgent agent alerts.</Say><Hangup/>");
}
