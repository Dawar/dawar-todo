import {
  disableTalkPhoneProfile,
  markTalkPhoneProviderConfigured,
  readTalkPhoneProfile,
  setTalkPhonePin,
} from "../../../../../db/talk-phone";
import { noStoreHeaders, talkErrorResponse, talkUserKey } from "../../../../../lib/talk-http";
import {
  configureTwilioVoiceWebhook,
  displayPhoneNumber,
  twilioPhoneConfig,
  twilioPhoneConfigured,
} from "../../../../../lib/twilio-phone";

function profileResponse(profile: Awaited<ReturnType<typeof readTalkPhoneProfile>>) {
  const config = twilioPhoneConfig();
  return {
    profile: {
      ...profile,
      providerReady: twilioPhoneConfigured(),
      phoneNumber: displayPhoneNumber(config.phoneNumber),
    },
  };
}

async function configureProvider(request: Request, userKey: string) {
  const profile = await readTalkPhoneProfile(userKey);
  if (!profile.configured) throw new Error("Set a phone PIN before connecting the Twilio number.");
  const webhookUrl = new URL("/api/talk/phone/incoming", request.url).toString();
  const provider = await configureTwilioVoiceWebhook(webhookUrl);
  await markTalkPhoneProviderConfigured(userKey, provider.webhookUrl);
  console.info("[todo-talk-phone-api] phone number connected", {
    userKey,
    webhookHost: new URL(provider.webhookUrl).host,
  });
  return profileResponse(await readTalkPhoneProfile(userKey));
}

export async function GET(request: Request) {
  try {
    const userKey = talkUserKey(request);
    return Response.json(profileResponse(await readTalkPhoneProfile(userKey)), {
      headers: noStoreHeaders,
    });
  } catch (error) {
    return talkErrorResponse(error, "Phone access settings could not be loaded.");
  }
}

export async function PUT(request: Request) {
  const startedAt = Date.now();
  let userKey = "";
  try {
    userKey = talkUserKey(request);
    const payload = await request.json() as { pin?: unknown };
    const pin = String(payload.pin ?? "").trim();
    await setTalkPhonePin(userKey, pin);
    const result = await configureProvider(request, userKey);
    console.info("[todo-talk-phone-api] phone PIN saved", {
      userKey,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(result, { headers: noStoreHeaders });
  } catch (error) {
    console.error("[todo-talk-phone-api] phone PIN setup failed", {
      userKey,
      durationMs: Date.now() - startedAt,
      error,
    });
    return talkErrorResponse(error, "Phone access could not be configured.");
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  let userKey = "";
  try {
    userKey = talkUserKey(request);
    const result = await configureProvider(request, userKey);
    console.info("[todo-talk-phone-api] Twilio setup refreshed", {
      userKey,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(result, { headers: noStoreHeaders });
  } catch (error) {
    console.error("[todo-talk-phone-api] Twilio setup refresh failed", {
      userKey,
      durationMs: Date.now() - startedAt,
      error,
    });
    return talkErrorResponse(error, "The Twilio number could not be connected.");
  }
}

export async function DELETE(request: Request) {
  try {
    const userKey = talkUserKey(request);
    await disableTalkPhoneProfile(userKey);
    return Response.json(profileResponse(await readTalkPhoneProfile(userKey)), {
      headers: noStoreHeaders,
    });
  } catch (error) {
    return talkErrorResponse(error, "Phone access could not be disabled.");
  }
}
