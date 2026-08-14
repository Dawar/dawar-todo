import {
  disableUrgentAlertsForUser,
  profileUserKeyForPhone,
} from "../../../../../../../../db/profile-phone";
import { applyUrgentAlertReply, type UrgentAlertAction } from "../../../../../../../../db/urgent-alerts";
import {
  twilioPhoneConfig,
  twilioXmlResponse,
  validateTwilioRequest,
  xmlEscape,
} from "../../../../../../../../lib/twilio-phone";

function messageResponse(message: string, status = 200) {
  return twilioXmlResponse(message ? `<Message>${xmlEscape(message)}</Message>` : "", status);
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const params = new URLSearchParams(await request.text());
    if (!await validateTwilioRequest(request, params)) {
      console.warn("[todo-urgent-alert] inbound SMS signature rejected");
      return messageResponse("", 403);
    }
    const config = twilioPhoneConfig();
    const accountSid = params.get("AccountSid")?.trim() ?? "";
    const from = params.get("From")?.trim() ?? "";
    const to = params.get("To")?.trim() ?? "";
    if (accountSid !== config.accountSid || to !== config.phoneNumber) {
      console.warn("[todo-urgent-alert] inbound SMS metadata rejected", {
        accountMatched: accountSid === config.accountSid,
        destinationMatched: to === config.phoneNumber,
      });
      return messageResponse("", 403);
    }
    const userKey = await profileUserKeyForPhone(from);
    if (!userKey) {
      console.warn("[todo-urgent-alert] inbound SMS sender not verified", {
        senderSuffix: from.replace(/\D/g, "").slice(-4),
      });
      return messageResponse("This number is not a verified Dawar Todo profile phone.");
    }
    const body = (params.get("Body") ?? "").trim().toUpperCase().replace(/\s+/g, " ");
    if (body === "STOP" || body === "UNSUBSCRIBE" || body === "CANCEL") {
      await disableUrgentAlertsForUser(userKey, "sms-stop");
      return messageResponse("Urgent agent calls and texts are disabled. Re-enable them in Dawar Todo Settings.");
    }
    if (body === "START") {
      return messageResponse("Open Dawar Todo Settings to re-enable urgent agent alerts.");
    }
    const match = body.match(/^(ACK|PIN|DONE|SNOOZE)(?:\s+([A-Z2-9]{6}))?(?:\s+(1H))?$/);
    if (!match) {
      return messageResponse("Reply ACK CODE, PIN CODE, SNOOZE CODE 1H, or DONE CODE.");
    }
    const actionByKeyword: Record<string, UrgentAlertAction> = {
      ACK: "ack",
      PIN: "pin",
      SNOOZE: "snooze",
      DONE: "done",
    };
    const result = await applyUrgentAlertReply({
      userKey,
      action: actionByKeyword[match[1]],
      code: match[2] ?? null,
    });
    console.info("[todo-urgent-alert] inbound SMS command processed", {
      userKey,
      action: actionByKeyword[match[1]],
      codeProvided: Boolean(match[2]),
      applied: result.applied,
      durationMs: Date.now() - startedAt,
    });
    if (!result.applied) {
      if ("reason" in result && result.reason === "pin-limit") {
        return messageResponse("Five tasks are already pinned. Unpin one, or reply ACK CODE, SNOOZE CODE 1H, or DONE CODE.");
      }
      return messageResponse("reason" in result && result.reason === "code-required"
        ? "More than one urgent alert is active. Include the 6-character code from the alert."
        : "That urgent alert is already handled or the code is invalid.");
    }
    const confirmation = match[1] === "PIN"
      ? "Task pinned. Alerts stopped."
      : match[1] === "SNOOZE"
        ? "Task snoozed for one hour. Alerts stopped."
        : match[1] === "DONE"
          ? "Task completed. Alerts stopped."
          : "Urgent alert acknowledged.";
    return messageResponse(confirmation);
  } catch (error) {
    console.error("[todo-urgent-alert] inbound SMS processing failed", {
      durationMs: Date.now() - startedAt,
      error,
    });
    return messageResponse("Dawar Todo could not process that reply. Try again or use the app.");
  }
}
