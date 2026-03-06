const express = require("express");
const pool = require("../db");

const router = express.Router();

function toImageUrl(image_path) {
  if (!image_path) return null;
  if (String(image_path).startsWith("http")) return image_path;

  const base =
  process.env.BASE_URL ||
  (process.env.NODE_ENV === "production"
    ? "https://apex-cabs-backend.onrender.com"
    : "http://localhost:5000");
  return `${base}${image_path}`;
}

router.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT vehicle_id, title, vehicle_number, vehicle_type, transmission, fuel_type,
             daily_rate, image_path, status,
             current_mileage, next_service_mileage
      FROM vehicles
      ORDER BY vehicle_id DESC
    `);

    res.json(rows.map((v) => ({ ...v, imageUrl: toImageUrl(v.image_path) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load vehicles" });
  }
});

router.get("/available", async (req, res) => {
  try {
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ message: "start and end are required" });
    }

    const { rows } = await pool.query(
      `
      SELECT v.vehicle_id, v.title, v.vehicle_number, v.vehicle_type, v.transmission, v.fuel_type,
             v.daily_rate, v.image_path, v.status,
             v.current_mileage, v.next_service_mileage
      FROM vehicles v
      WHERE v.status = 'available'
        AND v.vehicle_id NOT IN (
          SELECT b.vehicle_id
          FROM bookings b
          WHERE b.booking_status IN ('pending','confirmed')
            AND NOT (b.return_date < $1 OR b.rental_date > $2)
        )
      ORDER BY v.vehicle_id DESC
      `,
      [start, end]
    );

    res.json(rows.map((v) => ({ ...v, imageUrl: toImageUrl(v.image_path) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load available vehicles" });
  }
});

module.exports = router;