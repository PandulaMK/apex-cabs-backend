const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
  family: 4,
});

async function sendMail({ to, subject, html }) {
  return transporter.sendMail({
    from: `"Apex Cabs" <${process.env.MAIL_USER}>`,
    to,
    subject,
    html,
  });
}

module.exports = { sendMail };