import { readProfilePhone } from "../../../../../../db/profile-phone";
import { urgentAlertDiagnostics } from "../../../../../../db/urgent-alerts";
import { noStoreHeaders, talkErrorResponse, talkUserKey } from "../../../../../../lib/talk-http";

export async function GET(request: Request) {
  try {
    const userKey = talkUserKey(request);
    const [profilePhone, urgentAlerts] = await Promise.all([
      readProfilePhone(userKey),
      urgentAlertDiagnostics(userKey),
    ]);
    return Response.json({
      generatedAt: new Date().toISOString(),
      profilePhone: {
        configured: profilePhone.configured,
        urgentAlertsEnabled: profilePhone.urgentAlertsEnabled,
        providerReady: profilePhone.providerReady,
        voiceReady: profilePhone.voiceReady,
        smsReady: profilePhone.smsReady,
        callWindowStart: profilePhone.callWindowStart,
        callWindowEnd: profilePhone.callWindowEnd,
      },
      urgentAlerts,
    }, { headers: noStoreHeaders });
  } catch (error) {
    return talkErrorResponse(error, "Urgent alert diagnostics could not be loaded.");
  }
}
