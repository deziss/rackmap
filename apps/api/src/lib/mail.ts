export async function sendMail({ to, subject, text }: { to: string; subject: string; text: string }) {
  // If SMTP is configured, send here. For now, log to console.
  console.log(`\n=== EMAIL NOTIFICATION ===\nTo: ${to}\nSubject: ${subject}\n\n${text}\n==========================\n`);
}
