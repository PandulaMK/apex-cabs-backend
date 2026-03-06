const express = require("express");
const pool = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

router.post("/advance", requireAuth, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { booking_id, amount, method } = req.body;

    if (!booking_id) {
      return res.status(400).json({ message: "booking_id is required" });
    }

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ message: "amount must be a positive number" });
    }

    const allowedMethods = ["card", "bank", "cash"];
    const m = String(method || "card").toLowerCase();
    if (!allowedMethods.includes(m)) {
      return res.status(400).json({ message: "Invalid method. Use card|bank|cash" });
    }

    const { rows } = await pool.query(
      `
      SELECT booking_id, customer_id, booking_status,
             advance_paid, advance_amount, advance_paid_at
      FROM bookings
      WHERE booking_id = $1
      LIMIT 1
      `,
      [booking_id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const booking = rows[0];

    if (Number(booking.customer_id) !== Number(userId)) {
      return res.status(403).json({ message: "Not allowed to pay for this booking" });
    }

    if (booking.booking_status === "cancelled") {
      return res.status(400).json({ message: "Cannot pay advance for a cancelled booking" });
    }

    if (booking.advance_paid === true) {
      return res.json({
        message: "Advance already paid (dummy)",
        booking_id,
        amount: booking.advance_amount ?? amt,
        method: m,
        alreadyPaid: true,
      });
    }

    await pool.query(
      `
      UPDATE bookings
      SET advance_paid = TRUE,
          advance_amount = $1,
          advance_paid_at = now()
      WHERE booking_id = $2
      `,
      [amt, booking_id]
    );

    return res.json({
      message: "Payment success (dummy)",
      booking_id,
      amount: amt,
      method: m,
      alreadyPaid: false,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;