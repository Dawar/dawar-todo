import { twilioPhoneConfig, twilioXmlResponse, validateTwilioRequest } from "../../../../../../../../lib/twilio-phone";

export async function POST(request: Request) {
  const params = new URLSearchParams(await request.text());
  if (!await validateTwilioRequest(request, params)) return twilioXmlResponse("", 403);
  if (params.get("AccountSid")?.trim() !== twilioPhoneConfig().accountSid) return twilioXmlResponse("", 403);
  console.info("[todo-profile-phone] test voice status", {
    status: params.get("CallStatus")?.trim() ?? "unknown",
  });
  return twilioXmlResponse("");
}
