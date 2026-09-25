import { escapeEmailHtml, sendEmail } from "../services/email.service.js";

/**
 * Plain-text mail (the SSL expiry report). This used to be a console.log stub,
 * so the report was never actually delivered; it now goes through SMTP like
 * every other email, with the text escaped into a <pre> block.
 */
export async function sendMail({ to, subject, text }: { to: string; subject: string; text: string }) {
  await sendEmail({
    to,
    subject,
    html: `<pre style="font-family:ui-monospace,monospace;font-size:13px">${escapeEmailHtml(text)}</pre>`,
    text,
  });
}
