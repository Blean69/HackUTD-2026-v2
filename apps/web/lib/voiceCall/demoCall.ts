import { VOICE_URL } from "@/lib/constants";
import { requestBrianCall } from "@/lib/data/actions";

/** Ask the voice service to ring the demo phone about an alert. The number lives only on the voice service (DEMO_PHONE). */
export async function placeDemoCall(householdId: string, alertId: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await fetch(`${VOICE_URL}/api/demo_call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ household_id: householdId, alert_id: alertId }),
    });
    if (r.ok) {
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; status?: string };
      if (body.ok === false) return { ok: false, message: "Your phone carrier refused the call. Carriers block several calls to one number in a few minutes; try again in a few minutes." };
      return { ok: true, message: body.status === "completed" ? "Brian called your phone." : "Brian is calling your phone. Pick up in a few seconds." };
    }
    if (r.status === 429) return { ok: false, message: "Brian called a moment ago. Wait about two minutes between calls so the carrier doesn't block them." };
    return { ok: false, message: "Brian couldn't place the call right now." };
  } catch {
    return { ok: false, message: "Brian couldn't place the call right now." };
  }
}

/**
 * "Brian, call me about this alert": rings every phone and laptop in the room INSIDE the app (the incoming-call screen). A real phone
 * call is a separate, explicit choice (placeDemoCall), only where the voice service has a demo number.
 */
export async function callAboutAlert(householdId: string, alertId: string, title: string): Promise<{ ok: boolean; message: string; inApp: boolean }> {
  try {
    await requestBrianCall(householdId, alertId, title, "demo");
    return { ok: true, message: "Brian is calling everyone in the room. Look for the incoming call.", inApp: true };
  } catch {
    return { ok: false, message: "Brian couldn't call right now.", inApp: true };
  }
}
