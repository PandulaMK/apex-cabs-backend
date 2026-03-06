require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const cron = require("node-cron");

const pool = require("./db");

const authRoutes = require("./routes/auth.routes");
const userRoutes = require("./routes/user.routes");
const vehicleRoutes = require("./routes/vehicle.routes");
const bookingRoutes = require("./routes/booking.routes");
const contactRoutes = require("./routes/contact.routes");
const paymentRoutes = require("./routes/payment.routes");
const adminRoutes = require("./routes/admin.routes");
const ownerRoutes = require("./routes/owner.routes");

const app = express();
(async () => {
  try {
    const result = await pool.query("SELECT now()");
    console.log("✅ Connected to PostgreSQL");
    console.log("DB time:", result.rows[0].now);
  } catch (err) {
    console.error("❌ PostgreSQL connection failed:", err.message);
  }
})();
const allowedOrigins = [
  "http://localhost:5173",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  })
);

app.use(express.json());

// Serve uploaded images
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.get("/", (req, res) => res.send("Apex Cabs API running ✅"));
app.get("/health", (req, res) => res.status(200).send("OK"));

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/vehicles", vehicleRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/contact", contactRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/owner", ownerRoutes);

// Use ONLY ONE reminder system:
// Either keep this cron here
// OR remove this and keep require("./jobs/reminders.job")

cron.schedule("0 9 25 * *", async () => {
  try {
    const { rows } = await pool.query(`
      SELECT b.booking_id, b.customer_id, b.vehicle_id,
             u.email, u.full_name, u.phone_1,
             v.title, v.vehicle_number,
             b.rental_date, b.return_date
      FROM bookings b
      JOIN users u ON u.user_id = b.customer_id
      JOIN vehicles v ON v.vehicle_id = b.vehicle_id
      WHERE b.booking_status = 'confirmed'
        AND (b.return_date::date - b.rental_date::date) >= 30
        AND CURRENT_DATE BETWEEN b.rental_date::date AND b.return_date::date
    `);

    const monthKey = new Date().toISOString().slice(0, 7); // YYYY-MM

    for (const r of rows) {
      await pool.query(
        `
        INSERT INTO monthly_reminders (booking_id, reminder_month, reminder_type)
        VALUES ($1, $2, 'payment')
        ON CONFLICT (booking_id, reminder_month, reminder_type) DO NOTHING
        `,
        [r.booking_id, monthKey]
      );

      await pool.query(
        `
        INSERT INTO monthly_reminders (booking_id, reminder_month, reminder_type)
        VALUES ($1, $2, 'odometer')
        ON CONFLICT (booking_id, reminder_month, reminder_type) DO NOTHING
        `,
        [r.booking_id, monthKey]
      );

      console.log(
        `Reminder queued for booking ${r.booking_id} (${r.full_name}) vehicle ${r.vehicle_number} ${r.title}`
      );
    }
  } catch (err) {
    console.error("Monthly reminder cron failed:", err.message);
  }
});


app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT now()");
    res.json({
      message: "Supabase connected successfully",
      time: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Database connection failed",
      details: err.message
    });
  }
});
const PORT = process.env.PORT || 5000;
app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT now()");
    res.json({
      message: "Supabase connected successfully",
      time: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Database connection failed",
      details: err.message
    });
  }
});
app.listen(PORT, () => {
  console.log(`✅ API running on port ${PORT}`);
});
app.get("/health", (req, res) => res.status(200).send("OK"));