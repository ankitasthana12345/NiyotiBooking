const logger = require("../config/logger");

// Twilio's WhatsApp API has the same underlying rule as Meta's: a business-initiated
// message (like an unprompted booking confirmation) outside a 24-hour customer service
// window needs a pre-approved Content Template (Twilio's wrapper around WhatsApp Message
// Templates) — free-form `body` text only works as a reply inside that window, or on
// trial/sandbox numbers that have already messaged in. This service supports both, so it
// can be used for template sends now and free-form replies later if that's ever needed.
function isConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM);
}

function toWhatsAppAddress(number) {
  const trimmed = String(number).trim();
  return trimmed.startsWith("whatsapp:") ? trimmed : `whatsapp:${trimmed}`;
}

async function sendTwilioWhatsAppMessage({ to, contentSid, contentVariables, body }) {
  if (!isConfigured()) {
    logger.warn("Twilio WhatsApp is not configured. Message skipped.", { to });
    return { skipped: true };
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  const params = new URLSearchParams();
  params.set("To", toWhatsAppAddress(to));
  params.set("From", process.env.TWILIO_WHATSAPP_FROM);
  if (contentSid) {
    params.set("ContentSid", contentSid);
    if (contentVariables) params.set("ContentVariables", JSON.stringify(contentVariables));
  } else if (body) {
    params.set("Body", body);
  } else {
    throw new Error("sendTwilioWhatsAppMessage requires either contentSid or body");
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const result = await response.json();

  if (!response.ok) {
    const errorMessage = result?.message || `Twilio API error (HTTP ${response.status})`;
    logger.error("Failed to send Twilio WhatsApp message", { to, message: errorMessage, code: result?.code });
    throw new Error(errorMessage);
  }

  logger.info("Twilio WhatsApp message sent", { to, sid: result.sid, status: result.status });
  return result;
}

module.exports = {
  isConfigured,
  sendTwilioWhatsAppMessage,
};
