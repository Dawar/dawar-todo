import { readVerifiedProfilePhone } from "../../../../../../db/profile-phone";
import { noStoreHeaders, talkErrorResponse, talkUserKey } from "../../../../../../lib/talk-http";
import { createTwilioOutboundCall, sendTwilioSms } from "../../../../../../lib/twilio-phone";

export async function POST(request: Request) {
  const startedAt = Date.now();
  let userKey = "";
  try {
    userKey = talkUserKey(request);
    const contact = await readVerifiedProfilePhone(userKey);
    if (!contact) throw new Error("Verify a profile phone number first.");
    const voiceUrl = new URL("/api/talk/phone/urgent/provider/test/voice", request.url).toString();
    const voiceStatusUrl = new URL("/api/talk/phone/urgent/provider/test/status", request.url).toString();
    const [sms, voice] = await Promise.all([
      sendTwilioSms({
        to: contact.phoneNumber,
        body: "Dawar Todo test: your verified profile phone is ready for urgent agent alerts.",
      }),
      createTwilioOutboundCall({
        to: contact.phoneNumber,
        instructionUrl: voiceUrl,
        statusCallbackUrl: voiceStatusUrl,
      }),
    ]);
    console.info("[todo-profile-phone-api] test alert submitted", {
      userKey,
      smsStatus: sms.status,
      voiceStatus: voice.status,
      phoneSuffix: contact.phoneSuffix,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ sent: true, channels: ["sms", "voice"] }, { headers: noStoreHeaders });
  } catch (error) {
    console.error("[todo-profile-phone-api] test alert failed", { userKey, durationMs: Date.now() - startedAt, error });
    return talkErrorResponse(error, "The test call and text could not be sent.");
  }
}
