import {
  clearProfilePhone,
  readProfilePhone,
  updateProfilePhonePreferences,
} from "../../../../../db/profile-phone";
import { noStoreHeaders, talkErrorResponse, talkUserKey } from "../../../../../lib/talk-http";

export async function GET(request: Request) {
  try {
    const userKey = talkUserKey(request);
    return Response.json({ profilePhone: await readProfilePhone(userKey) }, { headers: noStoreHeaders });
  } catch (error) {
    return talkErrorResponse(error, "Your profile phone could not be loaded.");
  }
}

export async function PATCH(request: Request) {
  const startedAt = Date.now();
  let userKey = "";
  try {
    userKey = talkUserKey(request);
    const payload = await request.json() as {
      urgentAlertsEnabled?: unknown;
      callWindowStart?: unknown;
      callWindowEnd?: unknown;
    };
    if (typeof payload.urgentAlertsEnabled !== "boolean") {
      return Response.json({ error: "Choose whether urgent agent alerts are enabled." }, { status: 400, headers: noStoreHeaders });
    }
    const profilePhone = await updateProfilePhonePreferences(userKey, {
      urgentAlertsEnabled: payload.urgentAlertsEnabled,
      callWindowStart: Number(payload.callWindowStart),
      callWindowEnd: Number(payload.callWindowEnd),
    });
    console.info("[todo-profile-phone-api] profile phone preferences saved", {
      userKey,
      urgentAlertsEnabled: profilePhone.urgentAlertsEnabled,
      callWindowStart: profilePhone.callWindowStart,
      callWindowEnd: profilePhone.callWindowEnd,
      durationMs: Date.now() - startedAt,
    });
    return Response.json({ profilePhone }, { headers: noStoreHeaders });
  } catch (error) {
    console.error("[todo-profile-phone-api] profile phone preferences failed", {
      userKey,
      durationMs: Date.now() - startedAt,
      error,
    });
    return talkErrorResponse(error, "Your profile phone preferences could not be saved.");
  }
}

export async function DELETE(request: Request) {
  try {
    const userKey = talkUserKey(request);
    return Response.json({ profilePhone: await clearProfilePhone(userKey) }, { headers: noStoreHeaders });
  } catch (error) {
    return talkErrorResponse(error, "Your profile phone could not be removed.");
  }
}
