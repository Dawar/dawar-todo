import {
  beginProfilePhoneVerification,
  confirmProfilePhoneVerification,
} from "../../../../../../db/profile-phone";
import { noStoreHeaders, talkErrorResponse, talkUserKey } from "../../../../../../lib/talk-http";
import { configureTwilioMessagingWebhook } from "../../../../../../lib/twilio-phone";

export async function POST(request: Request) {
  const startedAt = Date.now();
  let userKey = "";
  try {
    userKey = talkUserKey(request);
    const payload = await request.json() as { phoneNumber?: unknown };
    const webhookUrl = new URL("/api/talk/phone/urgent/provider/sms/incoming", request.url).toString();
    const provider = await configureTwilioMessagingWebhook(webhookUrl);
    const verification = await beginProfilePhoneVerification(userKey, String(payload.phoneNumber ?? ""));
    console.info("[todo-profile-phone-api] verification requested", {
      userKey,
      challengeId: verification.challengeId,
      smsProviderReady: provider.smsCapable,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ verification }, { status: 201, headers: noStoreHeaders });
  } catch (error) {
    console.error("[todo-profile-phone-api] verification request failed", {
      userKey,
      durationMs: Date.now() - startedAt,
      error,
    });
    return talkErrorResponse(error, "The verification text could not be sent.");
  }
}

export async function PUT(request: Request) {
  const startedAt = Date.now();
  let userKey = "";
  try {
    userKey = talkUserKey(request);
    const payload = await request.json() as { challengeId?: unknown; code?: unknown };
    const profilePhone = await confirmProfilePhoneVerification(
      userKey,
      String(payload.challengeId ?? ""),
      String(payload.code ?? "").trim(),
    );
    console.info("[todo-profile-phone-api] verification confirmed", {
      userKey,
      urgentAlertsEnabled: profilePhone.urgentAlertsEnabled,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ profilePhone }, { headers: noStoreHeaders });
  } catch (error) {
    console.error("[todo-profile-phone-api] verification confirmation failed", {
      userKey,
      durationMs: Date.now() - startedAt,
      error,
    });
    return talkErrorResponse(error, "The profile phone could not be verified.");
  }
}
