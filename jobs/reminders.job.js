const cron = require("node-cron");
const pool = require("../db");
const { sendMail } = require("../utils/mailer");

cron.schedule("0 9 25 * *", async () => {
  try {
    const { rows: bookings } = await pool.query(`
      SELECT b.booking_id, b.rental_date, b.return_date,
             u.email AS customer_email, u.full_name AS customer_name,
             v.title AS vehicle_title, v.vehicle_number
      FROM bookings b
      JOIN users u ON u.user_id = b.customer_id
      JOIN vehicles v ON v.vehicle_id = b.vehicle_id
      WHERE b.booking_status = 'confirmed'
        AND b.return_date::date >= CURRENT_DATE
        AND (b.return_date::date - b.rental_date::date) >= 30
    `);

    for (const b of bookings) {
      await sendMail({
        to: b.customer_email,
        subject: "Apex Cabs - Monthly Payment Reminder (25th)",
        html: `
          <p>Hi ${b.customer_name},</p>
          <p>This is your monthly payment reminder (25th).</p>
          <p><b>Vehicle:</b> ${b.vehicle_title} (${b.vehicle_number})</p>
          <p><b>Booking ID:</b> ${b.booking_id}</p>
          <p>Thank you,<br/>Apex Cabs</p>
        `,
      });
    }

    const { rows: due } = await pool.query(`
      SELECT v.vehicle_id, v.title, v.vehicle_number,
             v.current_mileage, v.next_service_mileage,
             o.email AS owner_email, o.full_name AS owner_name
      FROM vehicles v
      JOIN users o ON o.user_id = v.owner_id
      WHERE v.current_mileage >= v.next_service_mileage
    `);

    for (const v of due) {
      await sendMail({
        to: v.owner_email,
        subject: "Apex Cabs - Maintenance Due",
        html: `
          <p>Hi ${v.owner_name},</p>
          <p>Your vehicle service is due.</p>
          <p><b>Vehicle:</b> ${v.title} (${v.vehicle_number})</p>
          <p><b>Current:</b> ${v.current_mileage} km</p>
          <p><b>Next service:</b> ${v.next_service_mileage} km</p>
          <p>Thanks,<br/>Apex Cabs</p>
        `,
      });
    }

    console.log(`✅ Auto reminders sent: bookings=${bookings.length}, maintenance=${due.length}`);
  } catch (err) {
    console.error("❌ Auto reminder job failed:", err);
  }
});