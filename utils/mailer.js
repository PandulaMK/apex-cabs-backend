const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});
async function sendMail({ to, subject, html }) {
  if (!to) throw new Error("Missing recipient email");

  return transporter.sendMail({
    from: `"${process.env.MAIL_FROM_NAME || "Apex Cabs"}" <${process.env.MAIL_USER}>`,
    to,
    subject,
    html,
  });
}

module.exports = { sendMail };