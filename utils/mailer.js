const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendMail({ to, subject, html }) {
  const response = await resend.emails.send({
    from: `Apex Cabs <${process.env.MAIL_FROM}>`,
    to: to,
    subject: subject,
    html: html,
  });

  return response;
}

module.exports = { sendMail };