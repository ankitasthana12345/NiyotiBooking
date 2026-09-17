const logger = require("../config/logger");

// WhatsApp Cloud API only allows business-initiated messages (like a booking confirmation
// the customer didn't just ask for) through pre-approved Message Templates — free-form text
// is only allowed as a *reply* inside a 24-hour customer service window. So this service is
// deliberately generic: it sends whatever approved template you give it. There is currently
// no approved "booking confirmed / rejected / rescheduled" template — those need to be
// created and approved in WhatsApp Manager before this can be wired into the booking flow.
function isConfigured() {
  return Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

async function sendWhatsAppTemplateMessage({ to, templateName, languageCode = "en_US", bodyParams = [] }) {
  if (!isConfigured()) {
    logger.warn("WhatsApp is not configured. Message skipped.", { to, templateName });
    return { skipped: true };
  }

  const apiVersion = process.env.WHATSAPP_API_VERSION || "v25.0";
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: to.replace(/[^\d]/g, ""), // Cloud API wants digits only, no "+" or spaces
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components: bodyParams.length
        ? [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text: String(text) })) }]
        : [],
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json();

  if (!response.ok) {
    const errorMessage = result?.error?.message || `WhatsApp API error (HTTP ${response.status})`;
    logger.error("Failed to send WhatsApp message", { to, templateName, message: errorMessage, details: result?.error });
    throw new Error(errorMessage);
  }

  logger.info("WhatsApp message sent", { to, templateName, messageId: result?.messages?.[0]?.id });
  return result;
}

module.exports = {
  isConfigured,
  sendWhatsAppTemplateMessage,
};
