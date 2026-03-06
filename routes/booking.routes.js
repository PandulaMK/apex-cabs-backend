const express = require("express");
const pool = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

/**
 * Helper: overlap check
 * Overlap exists if NOT (existing ends before start OR existing starts after end)
 * We ignore cancelled + completed bookings.
 */
async function hasOverlapBooking(vehicle_id, startDate, endDate, ignoreBookingId = null) {
  let sql = `
    SELECT booking_id
    FROM bookings
    WHERE vehicle_id = $1
      AND booking_status IN ('pending','confirmed')
      AND NOT (return_date < $2 OR rental_date > $3)
  `;

  const params = [vehicle_id, startDate, endDate];

  if (ignoreBookingId) {
    sql += ` AND booking_id <> $4`;
    params.push(ignoreBookingId);
  }

  sql += ` LIMIT 1`;

  const { rows } = await pool.query(sql, params);
  return rows.length > 0;
}

/**
 * Helper: ensure long-term active booking owned by user
 */
async function getActiveLongTermBooking(bookingId, customerId) {
  const { rows } = await pool.query(
    `
    SELECT booking_id, customer_id, vehicle_id, rental_date, return_date, booking_status,
           (return_date::date - rental_date::date) AS duration_days
    FROM bookings
    WHERE booking_id = $1
      AND customer_id = $2
      AND booking_status = 'confirmed'
      AND (return_date::date - rental_date::date) >= 30
      AND CURRENT_DATE BETWEEN rental_date::date AND return_date::date
    `,
    [bookingId, customerId]
  );

  return rows[0];
}
/**
 * GET /api/bookings/availability?vehicle_id=1&start=YYYY-MM-DD&end=YYYY-MM-DD
 */
router.get("/availability", async (req, res) => {
  try {
    const { vehicle_id, start, end } = req.query;

    if (!vehicle_id || !start || !end) {
      return res.status(400).json({ message: "vehicle_id, start, end are required" });
    }
    if (new Date(start) > new Date(end)) {
      return res.status(400).json({ message: "Start date must be <= end date" });
    }

    const overlap = await hasOverlapBooking(Number(vehicle_id), start, end);
    return res.json({ available: !overlap });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * POST /api/bookings
 * body: { vehicle_id, rental_date, return_date }
 * Saves to bookings.customer_id + bookings.booking_status
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const customerId = req.user.user_id;
    const { vehicle_id, rental_date, return_date } = req.body;

    if (!vehicle_id || !rental_date || !return_date) {
      return res.status(400).json({ message: "Missing booking fields" });
    }

    // ✅ Parse safely (avoid timezone shifts)
    const start = new Date(`${rental_date}T00:00:00`);
    const end = new Date(`${return_date}T00:00:00`);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res
        .status(400)
        .json({ message: "Invalid date format (use YYYY-MM-DD)" });
    }

    // ✅ Today start
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // ✅ Block past rental dates
    if (start < today) {
      return res
        .status(400)
        .json({ message: "Rental date cannot be in the past" });
    }

    // ✅ Block same-day and reversed dates
    if (start >= end) {
      return res
        .status(400)
        .json({ message: "Return date must be after rental date" });
    }

    // ✅ Check availability overlap
    const overlap = await hasOverlapBooking(
      Number(vehicle_id),
      rental_date,
      return_date
    );

    if (overlap) {
      return res
        .status(409)
        .json({ message: "Vehicle is not available for these dates" });
    }

    // ✅ Insert booking
    const result = await pool.query(
  `
  INSERT INTO bookings (customer_id, vehicle_id, rental_date, return_date, booking_status, advance_paid, advance_amount)
  VALUES ($1, $2, $3, $4, 'confirmed', FALSE, NULL)
  RETURNING booking_id
  `,
  [customerId, vehicle_id, rental_date, return_date]
);

res.json({ message: "Booking created", booking_id: result.rows[0].booking_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * GET /api/bookings/my
 * Returns bookings + vehicle details + payment fields
 * Also returns duration_days + is_long_term
 */
router.get("/my", requireAuth, async (req, res) => {
  try {
    const customerId = req.user.user_id;

    const { rows } = await pool.query(
  `
  SELECT
    b.booking_id,
    b.rental_date,
    b.return_date,
    b.booking_status,
    (b.return_date::date - b.rental_date::date) AS duration_days,
    ((b.return_date::date - b.rental_date::date) >= 30) AS is_long_term,
    v.vehicle_id,
    v.title,
    v.vehicle_type,
    v.transmission,
    v.fuel_type,
    v.daily_rate,
    v.image_path
  FROM bookings b
  JOIN vehicles v ON v.vehicle_id = b.vehicle_id
  WHERE b.customer_id = $1
  ORDER BY b.booking_id DESC
  `,
  [customerId]
);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * PUT /api/bookings/:id/cancel
 */
router.put("/:id/cancel", requireAuth, async (req, res) => {
  try {
    const customerId = req.user.user_id;
    const bookingId = req.params.id;

    const result = await pool.query(
  `
  UPDATE bookings
  SET booking_status = 'cancelled'
  WHERE booking_id = $1 AND customer_id = $2
  `,
  [bookingId, customerId]
);

if (result.rowCount === 0) {
  return res.status(404).json({ message: "Booking not found or not yours" });
}

    res.json({ message: "Booking cancelled" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ✅ POST /api/bookings/:id/odometer
// body: { mileage, note? }
router.post("/:id/odometer", requireAuth, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const bookingId = req.params.id;

    // accept either mileage or odometer from frontend
    const mileageInput = req.body.mileage ?? req.body.odometer;
    const note = (req.body.note || "").trim() || null;

    const mileage = Number(mileageInput);
    if (!Number.isFinite(mileage) || mileage <= 0) {
      return res.status(400).json({ message: "mileage must be a positive number" });
    }

    // only on 25th
    const day = new Date().getDate();
    if (day !== 25) {
      return res.status(400).json({ message: "Odometer update allowed only on 25th" });
    }

    // must be a confirmed long-term active booking owned by user
    const { rows: activeRows } = await pool.query(
  `
  SELECT booking_id
  FROM bookings
  WHERE booking_id = $1
    AND customer_id = $2
    AND booking_status = 'confirmed'
    AND (return_date::date - rental_date::date) >= 30
    AND CURRENT_DATE BETWEEN rental_date::date AND return_date::date
  `,
  [bookingId, userId]
);

const b = activeRows[0];

    if (!b) {
      return res.status(403).json({
        message: "Odometer update allowed only for active long-term confirmed bookings",
      });
    }

    // prevent duplicate submission for same month
    const monthKey = new Date().toISOString().slice(0, 7);

const { rows: dupRows } = await pool.query(
  `
  SELECT id
  FROM booking_mileage_updates
  WHERE booking_id = $1
    AND user_id = $2
    AND TO_CHAR(created_at, 'YYYY-MM') = $3
  LIMIT 1
  `,
  [bookingId, userId, monthKey]
);

if (dupRows[0]) {
  return res.status(409).json({ message: "Mileage already submitted for this month" });
}

    // ✅ insert matching your table columns
    await pool.query(
  `
  INSERT INTO booking_mileage_updates (booking_id, user_id, mileage, note)
  VALUES ($1, $2, $3, $4)
  `,
  [bookingId, userId, mileage, note]
);

    res.json({ message: "Mileage saved" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
