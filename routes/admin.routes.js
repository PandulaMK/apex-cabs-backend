const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const bcrypt = require("bcrypt");
const cron = require("node-cron");

const pool = require("../db");
const requireAuth = require("../middleware/auth");
const { sendMail } = require("../utils/mailer");

const requireAdmin = requireAuth.requireAdmin;
const router = express.Router();

/* ---------------------------
   Multer setup (vehicle images)
---------------------------- */
const uploadDir = path.join(__dirname, "..", "uploads", "vehicles");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, `veh_${Date.now()}${ext}`);
  },
});

const fileFilter = (req, file, cb) => {
  const ok = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
  cb(ok ? null : new Error("Only JPG/PNG/WEBP allowed"), ok);
};

const upload = multer({ storage, fileFilter });

/* ---------------------------
   Dashboard stats
---------------------------- */
router.get("/stats", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows: vehicleRows } = await pool.query(
      "SELECT COUNT(*)::int AS total FROM vehicles"
    );

    const { rows: activeRows } = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM bookings
      WHERE booking_status = 'confirmed'
        AND CURRENT_DATE BETWEEN rental_date::date AND return_date::date
    `);

    const { rows: pendingRows } = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM bookings
      WHERE advance_paid = FALSE
        AND booking_status IN ('pending', 'confirmed')
    `);

    const { rows: maintenanceRows } = await pool.query(`
      SELECT COUNT(*)::int AS total
      FROM vehicles
      WHERE current_mileage >= next_service_mileage
    `);

    res.json({
      totalVehicles: vehicleRows[0]?.total || 0,
      activeRentals: activeRows[0]?.total || 0,
      pendingPayments: pendingRows[0]?.total || 0,
      maintenanceDue: maintenanceRows[0]?.total || 0,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ---------------------------
   USERS (customers)
---------------------------- */
router.get("/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const like = `%${search}%`;

    const { rows } = await pool.query(
      `
      SELECT user_id, role, full_name, email, nic, address, phone_1, phone_2, created_at
      FROM users
      WHERE role = 'customer'
        AND (
          $1 = '' OR
          full_name ILIKE $2 OR
          email ILIKE $3 OR
          nic ILIKE $4 OR
          phone_1 ILIKE $5 OR
          phone_2 ILIKE $6
        )
      ORDER BY user_id DESC
      `,
      [search, like, like, like, like, like]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { full_name, email, password, nic, address, phone_1, phone_2 } = req.body;

    if (!full_name || !email || !password || !nic) {
      return res
        .status(400)
        .json({ message: "full_name, email, password, nic are required" });
    }

    const { rows: exists } = await pool.query(
      "SELECT user_id FROM users WHERE email = $1 OR nic = $2 LIMIT 1",
      [email, nic]
    );

    if (exists.length) {
      return res.status(409).json({ message: "Email or NIC already exists" });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `
      INSERT INTO users (role, full_name, email, password_hash, nic, address, phone_1, phone_2)
      VALUES ('customer', $1, $2, $3, $4, $5, $6, $7)
      RETURNING user_id
      `,
      [
        full_name,
        email,
        password_hash,
        nic,
        address || null,
        phone_1 || null,
        phone_2 || null,
      ]
    );

    res.json({ message: "Customer created", user_id: result.rows[0].user_id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete("/users/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);

    const { rows: uRows } = await pool.query(
      "SELECT role FROM users WHERE user_id = $1",
      [userId]
    );

    if (!uRows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    if (uRows[0].role === "admin") {
      return res.status(400).json({ message: "Cannot delete admin" });
    }

    await pool.query("UPDATE vehicles SET owner_id = NULL WHERE owner_id = $1", [userId]);
    await pool.query("DELETE FROM users WHERE user_id = $1", [userId]);

    res.json({ message: "User deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ---------------------------
   VEHICLES
---------------------------- */
router.get("/vehicles", requireAuth, requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const like = `%${search}%`;

    const { rows } = await pool.query(
      `
      SELECT
        v.vehicle_id,
        v.owner_id,
        o.full_name AS owner_name,
        o.phone_1 AS owner_phone,
        o.email AS owner_email,
        v.title,
        v.vehicle_number,
        v.vehicle_type,
        v.transmission,
        v.fuel_type,
        v.daily_rate,
        v.image_path,
        v.status,
        v.created_at,
        v.current_mileage,
        v.last_service_mileage,
        v.service_interval,
        v.next_service_mileage
      FROM vehicles v
      LEFT JOIN users o ON o.user_id = v.owner_id
      WHERE (
        $1 = '' OR
        v.title ILIKE $2 OR
        v.vehicle_number ILIKE $3 OR
        v.vehicle_type ILIKE $4 OR
        v.transmission ILIKE $5 OR
        v.fuel_type ILIKE $6 OR
        o.full_name ILIKE $7 OR
        o.phone_1 ILIKE $8
      )
      ORDER BY v.vehicle_id DESC
      `,
      [search, like, like, like, like, like, like, like]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post(
  "/vehicles",
  requireAuth,
  requireAdmin,
  upload.single("image"),
  async (req, res) => {
    try {
      const {
        owner_id,
        title,
        vehicle_number,
        vehicle_type,
        transmission,
        fuel_type,
        daily_rate,
        status,
        current_mileage,
        last_service_mileage,
        service_interval,
        next_service_mileage,
      } = req.body;

      if (!title || !vehicle_number || !vehicle_type || !transmission || !fuel_type || !daily_rate) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const image_path = req.file ? `/uploads/vehicles/${req.file.filename}` : null;

      const result = await pool.query(
        `
        INSERT INTO vehicles
          (
            owner_id, title, vehicle_number, vehicle_type, transmission, fuel_type,
            daily_rate, image_path, status, current_mileage, last_service_mileage,
            service_interval, next_service_mileage
          )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING vehicle_id
        `,
        [
          owner_id ? Number(owner_id) : null,
          title,
          vehicle_number,
          vehicle_type,
          transmission,
          fuel_type,
          Number(daily_rate),
          image_path,
          status || "available",
          Number(current_mileage || 0),
          Number(last_service_mileage || 0),
          Number(service_interval || 5000),
          Number(next_service_mileage || 5000),
        ]
      );

      res.json({
        message: "Vehicle created",
        vehicle_id: result.rows[0].vehicle_id,
        image_path,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

router.put(
  "/vehicles/:id",
  requireAuth,
  requireAdmin,
  upload.single("image"),
  async (req, res) => {
    try {
      const vehicleId = Number(req.params.id);

      const {
        owner_id,
        title,
        vehicle_number,
        vehicle_type,
        transmission,
        fuel_type,
        daily_rate,
        status,
        current_mileage,
        last_service_mileage,
        service_interval,
        next_service_mileage,
      } = req.body;

      const image_path = req.file ? `/uploads/vehicles/${req.file.filename}` : null;

      await pool.query(
        `
        UPDATE vehicles
        SET owner_id = $1,
            title = $2,
            vehicle_number = $3,
            vehicle_type = $4,
            transmission = $5,
            fuel_type = $6,
            daily_rate = $7,
            status = $8,
            current_mileage = $9,
            last_service_mileage = $10,
            service_interval = $11,
            next_service_mileage = $12
        WHERE vehicle_id = $13
        `,
        [
          owner_id ? Number(owner_id) : null,
          title,
          vehicle_number,
          vehicle_type,
          transmission,
          fuel_type,
          Number(daily_rate),
          status,
          Number(current_mileage || 0),
          Number(last_service_mileage || 0),
          Number(service_interval || 5000),
          Number(next_service_mileage || 5000),
          vehicleId,
        ]
      );

      if (image_path) {
        await pool.query(
          "UPDATE vehicles SET image_path = $1 WHERE vehicle_id = $2",
          [image_path, vehicleId]
        );
      }

      res.json({ message: "Vehicle updated", image_path: image_path || undefined });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  }
);

router.delete("/vehicles/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const vehicleId = Number(req.params.id);
    await pool.query("DELETE FROM vehicles WHERE vehicle_id = $1", [vehicleId]);
    res.json({ message: "Vehicle deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ---------------------------
   BOOKINGS
---------------------------- */
router.get("/bookings", requireAuth, requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const like = `%${search}%`;

    const { rows } = await pool.query(
      `
      SELECT
        b.booking_id,
        TO_CHAR(b.rental_date::date, 'YYYY-MM-DD') AS rental_date,
        TO_CHAR(b.return_date::date, 'YYYY-MM-DD') AS return_date,
        b.booking_status,
        b.odometer_start,
        b.odometer_end,
        b.advance_paid,
        b.advance_amount,
        b.advance_paid_at,
        u.user_id AS customer_id,
        u.full_name AS customer_name,
        u.phone_1 AS customer_phone,
        v.vehicle_id,
        v.title AS vehicle_title,
        v.vehicle_number
      FROM bookings b
      JOIN users u ON u.user_id = b.customer_id
      JOIN vehicles v ON v.vehicle_id = b.vehicle_id
      WHERE (
        $1 = '' OR
        u.full_name ILIKE $2 OR
        u.phone_1 ILIKE $3 OR
        v.title ILIKE $4 OR
        v.vehicle_number ILIKE $5
      )
      ORDER BY b.booking_id DESC
      `,
      [search, like, like, like, like]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put("/bookings/:id/status", requireAuth, requireAdmin, async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    const { booking_status } = req.body;

    const allowed = ["pending", "confirmed", "cancelled", "completed"];
    if (!allowed.includes(booking_status)) {
      return res.status(400).json({ message: "Invalid booking_status" });
    }

    await pool.query(
      "UPDATE bookings SET booking_status = $1 WHERE booking_id = $2",
      [booking_status, bookingId]
    );

    res.json({ message: "Booking status updated" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/bookings", requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      customer_id,
      vehicle_id,
      rental_date,
      return_date,
      booking_status = "pending",
      advance_paid = 0,
      advance_amount = null,
    } = req.body;

    if (!customer_id || !vehicle_id || !rental_date || !return_date) {
      return res.status(400).json({
        message: "customer_id, vehicle_id, rental_date, return_date are required",
      });
    }

    const start = new Date(`${rental_date}T00:00:00`);
    const end = new Date(`${return_date}T00:00:00`);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ message: "Invalid date format (use YYYY-MM-DD)" });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (start < today) {
      return res.status(400).json({ message: "rental_date cannot be in the past" });
    }

    if (start >= end) {
      return res.status(400).json({ message: "return_date must be after rental_date" });
    }

    const { rows: conflicts } = await pool.query(
      `
      SELECT booking_id
      FROM bookings
      WHERE vehicle_id = $1
        AND booking_status IN ('pending', 'confirmed')
        AND NOT (return_date <= $2 OR rental_date >= $3)
      LIMIT 1
      `,
      [vehicle_id, rental_date, return_date]
    );

    if (conflicts.length) {
      return res.status(409).json({
        message: "Vehicle already booked for the selected dates",
      });
    }

    const ap = Number(advance_paid) ? true : false;
    const amt =
      ap === true
        ? advance_amount === "" || advance_amount == null
          ? null
          : Number(advance_amount)
        : null;

    const result = await pool.query(
      `
      INSERT INTO bookings
        (
          customer_id, vehicle_id, rental_date, return_date,
          booking_status, advance_paid, advance_amount, advance_paid_at
        )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING booking_id
      `,
      [
        customer_id,
        vehicle_id,
        rental_date,
        return_date,
        booking_status,
        ap,
        amt,
        ap ? new Date() : null,
      ]
    );

    res.json({ message: "Booking created", booking_id: result.rows[0].booking_id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put("/bookings/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const bookingId = Number(req.params.id);
    const {
      customer_id,
      vehicle_id,
      rental_date,
      return_date,
      booking_status,
      advance_paid,
      advance_amount,
    } = req.body;

    if (booking_status != null) {
      const allowed = ["pending", "confirmed", "cancelled", "completed"];
      if (!allowed.includes(booking_status)) {
        return res.status(400).json({ message: "Invalid booking_status" });
      }
    }

    const { rows: currentRows } = await pool.query(
      `
      SELECT
        booking_id,
        customer_id,
        vehicle_id,
        TO_CHAR(rental_date::date, 'YYYY-MM-DD') AS rental_date,
        TO_CHAR(return_date::date, 'YYYY-MM-DD') AS return_date
      FROM bookings
      WHERE booking_id = $1
      LIMIT 1
      `,
      [bookingId]
    );

    if (!currentRows.length) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const current = currentRows[0];

    const effectiveVehicleId = vehicle_id != null ? vehicle_id : current.vehicle_id;
    const effectiveRentalDate = rental_date != null ? rental_date : current.rental_date;
    const effectiveReturnDate = return_date != null ? return_date : current.return_date;

    const start = new Date(`${effectiveRentalDate}T00:00:00`);
    const end = new Date(`${effectiveReturnDate}T00:00:00`);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ message: "Invalid date format (use YYYY-MM-DD)" });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (start < today) {
      return res.status(400).json({ message: "rental_date cannot be in the past" });
    }

    if (start >= end) {
      return res.status(400).json({ message: "return_date must be after rental_date" });
    }

    const { rows: conflicts } = await pool.query(
      `
      SELECT booking_id
      FROM bookings
      WHERE vehicle_id = $1
        AND booking_id <> $2
        AND booking_status IN ('pending', 'confirmed')
        AND NOT (return_date <= $3 OR rental_date >= $4)
      LIMIT 1
      `,
      [effectiveVehicleId, bookingId, effectiveRentalDate, effectiveReturnDate]
    );

    if (conflicts.length) {
      return res.status(409).json({
        message: "Vehicle already booked for the selected dates",
      });
    }

    const fields = [];
    const values = [];

    const add = (column, value) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };

    if (customer_id != null) add("customer_id", customer_id);
    if (vehicle_id != null) add("vehicle_id", vehicle_id);
    if (rental_date != null) add("rental_date", rental_date);
    if (return_date != null) add("return_date", return_date);
    if (booking_status != null) add("booking_status", booking_status);

    if (advance_paid != null) {
      const ap = Number(advance_paid) ? true : false;
      add("advance_paid", ap);

      if (ap) {
        add(
          "advance_amount",
          advance_amount === "" || advance_amount == null ? null : Number(advance_amount)
        );
        fields.push("advance_paid_at = now()");
      } else {
        fields.push("advance_amount = NULL");
        fields.push("advance_paid_at = NULL");
      }
    } else if (advance_amount !== undefined) {
      add(
        "advance_amount",
        advance_amount === "" || advance_amount == null ? null : Number(advance_amount)
      );
    }

    if (!fields.length) {
      return res.status(400).json({ message: "No fields to update" });
    }

    values.push(bookingId);

    await pool.query(
      `UPDATE bookings SET ${fields.join(", ")} WHERE booking_id = $${values.length}`,
      values
    );

    res.json({ message: "Booking updated" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ---------------------------
   VEHICLE OWNERS
---------------------------- */
router.get("/owners", requireAuth, requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const like = `%${search}%`;

    const { rows } = await pool.query(
      `
      SELECT user_id, role, full_name, email, nic, address, phone_1, phone_2, created_at
      FROM users
      WHERE role = 'owner'
        AND (
          $1 = '' OR
          full_name ILIKE $2 OR
          email ILIKE $3 OR
          nic ILIKE $4 OR
          phone_1 ILIKE $5 OR
          phone_2 ILIKE $6
        )
      ORDER BY user_id DESC
      `,
      [search, like, like, like, like, like]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/owners", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { full_name, email, password, nic, address, phone_1, phone_2 } = req.body;

    if (!full_name || !email || !password || !nic) {
      return res
        .status(400)
        .json({ message: "full_name, email, password, nic are required" });
    }

    const { rows: exists } = await pool.query(
      "SELECT user_id FROM users WHERE email = $1 OR nic = $2 LIMIT 1",
      [email, nic]
    );

    if (exists.length) {
      return res.status(409).json({ message: "Email or NIC already exists" });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `
      INSERT INTO users (role, full_name, email, password_hash, nic, address, phone_1, phone_2)
      VALUES ('owner', $1, $2, $3, $4, $5, $6, $7)
      RETURNING user_id
      `,
      [
        full_name,
        email,
        password_hash,
        nic,
        address || null,
        phone_1 || null,
        phone_2 || null,
      ]
    );

    res.json({ message: "Owner created", user_id: result.rows[0].user_id });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/vehicle-owners", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT user_id, full_name, email, phone_1
      FROM users
      WHERE role = 'owner'
      ORDER BY full_name ASC
    `);

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.delete("/vehicle-owners/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!id) {
      return res.status(400).json({ message: "Invalid owner id" });
    }

    const { rows } = await pool.query(
      "SELECT user_id, role FROM users WHERE user_id = $1",
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Owner not found" });
    }

    if (rows[0].role !== "owner") {
      return res.status(400).json({ message: "This user is not an owner" });
    }

    const { rows: hasVehicles } = await pool.query(
      "SELECT vehicle_id FROM vehicles WHERE owner_id = $1 LIMIT 1",
      [id]
    );

    if (hasVehicles.length) {
      return res.status(400).json({
        message: "Cannot delete. This owner is assigned to vehicles. Reassign vehicles first.",
      });
    }

    await pool.query("DELETE FROM users WHERE user_id = $1", [id]);
    res.json({ message: "Owner deleted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put("/owners/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const ownerId = Number(req.params.id);
    const { full_name, nic, address, phone_1, phone_2, email } = req.body;

    await pool.query(
      `
      UPDATE users
      SET full_name = $1,
          nic = $2,
          address = $3,
          phone_1 = $4,
          phone_2 = $5,
          email = $6
      WHERE user_id = $7 AND role = 'owner'
      `,
      [full_name, nic, address, phone_1, phone_2, email, ownerId]
    );

    res.json({ message: "Owner updated" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ---------------------------
   PAYMENTS
---------------------------- */
router.get("/payments", requireAuth, requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const like = `%${search}%`;

    const { rows } = await pool.query(
      `
      SELECT
        b.booking_id,
        u.user_id AS user_id,
        u.full_name AS user_name,
        u.full_name AS customer_name,
        u.phone_1 AS customer_phone,
        v.title AS vehicle_title,
        v.vehicle_number,
        v.daily_rate,
        b.rental_date,
        b.return_date,
        b.advance_paid,
        b.advance_amount,
        b.advance_paid_at,
        b.booking_status
      FROM bookings b
      JOIN users u ON u.user_id = b.customer_id
      JOIN vehicles v ON v.vehicle_id = b.vehicle_id
      WHERE (
        $1 = '' OR
        u.full_name ILIKE $2 OR
        u.phone_1 ILIKE $3 OR
        v.title ILIKE $4 OR
        v.vehicle_number ILIKE $5
      )
      ORDER BY b.booking_id DESC
      `,
      [search, like, like, like, like]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put("/payments/:bookingId/mark-paid", requireAuth, requireAdmin, async (req, res) => {
  try {
    const bookingId = Number(req.params.bookingId);
    const { amount } = req.body;

    const amt = Number(amount || 0);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ message: "amount must be > 0" });
    }

    await pool.query(
      `
      UPDATE bookings
      SET advance_paid = TRUE,
          advance_amount = $1,
          advance_paid_at = now()
      WHERE booking_id = $2
      `,
      [amt, bookingId]
    );

    res.json({ message: "Marked as paid" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ---------------------------
   MAINTENANCE
---------------------------- */
router.get("/maintenance", requireAuth, requireAdmin, async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const like = `%${search}%`;

    const { rows } = await pool.query(
      `
      SELECT
        vehicle_id,
        title,
        vehicle_number,
        status,
        current_mileage,
        last_service_mileage,
        service_interval,
        next_service_mileage,
        CASE
          WHEN current_mileage >= next_service_mileage THEN 'DUE'
          ELSE 'OK'
        END AS service_status
      FROM vehicles
      WHERE (
        $1 = '' OR
        title ILIKE $2 OR
        vehicle_number ILIKE $3
      )
      ORDER BY (current_mileage >= next_service_mileage) DESC, vehicle_id DESC
      `,
      [search, like, like]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.put("/maintenance/:vehicleId/mark-serviced", requireAuth, requireAdmin, async (req, res) => {
  try {
    const vehicleId = Number(req.params.vehicleId);

    await pool.query(
      `
      UPDATE vehicles
      SET last_service_mileage = current_mileage,
          next_service_mileage = current_mileage + service_interval
      WHERE vehicle_id = $1
      `,
      [vehicleId]
    );

    res.json({ message: "Vehicle marked as serviced" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ---------------------------
   EMAILS / REMINDERS
---------------------------- */
router.post("/bookings/:id/remind-payment", requireAuth, requireAdmin, async (req, res) => {
  try {
    const bookingId = Number(req.params.id);

    const { rows } = await pool.query(
      `
      SELECT
        b.booking_id,
        b.advance_amount,
        b.advance_paid,
        u.email AS customer_email,
        u.full_name AS customer_name,
        v.title AS vehicle_title,
        v.vehicle_number,
        b.rental_date,
        b.return_date
      FROM bookings b
      JOIN users u ON u.user_id = b.customer_id
      JOIN vehicles v ON v.vehicle_id = b.vehicle_id
      WHERE b.booking_id = $1
      LIMIT 1
      `,
      [bookingId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Booking not found" });
    }

    const b = rows[0];

    await sendMail({
      to: b.customer_email,
      subject: "Apex Cabs - Payment Reminder",
      html: `
        <p>Hi ${b.customer_name},</p>
        <p>This is a payment reminder for your rental.</p>
        <p><b>Vehicle:</b> ${b.vehicle_title} (${b.vehicle_number})</p>
        <p><b>Rental:</b> ${String(b.rental_date).slice(0, 10)} → ${String(b.return_date).slice(0, 10)}</p>
        <p><b>Advance Amount:</b> ${b.advance_amount ?? "—"}</p>
        <p>Thank you,<br/>Apex Cabs</p>
      `,
    });

    res.json({ message: "Payment reminder email sent" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/vehicles/:id/remind-maintenance", requireAuth, requireAdmin, async (req, res) => {
  try {
    const vehicleId = Number(req.params.id);

    const { rows } = await pool.query(
      `
      SELECT
        v.vehicle_id,
        v.title,
        v.vehicle_number,
        v.current_mileage,
        v.next_service_mileage,
        o.email AS owner_email,
        o.full_name AS owner_name
      FROM vehicles v
      JOIN users o ON o.user_id = v.owner_id
      WHERE v.vehicle_id = $1
      LIMIT 1
      `,
      [vehicleId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "Vehicle/Owner not found" });
    }

    const v = rows[0];

    await sendMail({
      to: v.owner_email,
      subject: "Apex Cabs - Maintenance Due Reminder",
      html: `
        <p>Hi ${v.owner_name},</p>
        <p>Your vehicle service is due.</p>
        <p><b>Vehicle:</b> ${v.title} (${v.vehicle_number})</p>
        <p><b>Current mileage:</b> ${v.current_mileage}</p>
        <p><b>Next service at:</b> ${v.next_service_mileage}</p>
        <p>Please arrange maintenance.</p>
        <p>Thanks,<br/>Apex Cabs</p>
      `,
    });

    res.json({ message: "Maintenance reminder email sent" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/reminders/test-email", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { to, type } = req.body;

    if (!to) {
      return res.status(400).json({ message: "Missing 'to' email" });
    }

    const subject =
      type === "maintenance"
        ? "TEST: Apex Cabs Maintenance Reminder"
        : "TEST: Apex Cabs Payment Reminder";

    const html =
      type === "maintenance"
        ? "<p>✅ TEST maintenance reminder email sent successfully.</p>"
        : "<p>✅ TEST payment reminder email sent successfully.</p>";

    await sendMail({ to, subject, html });

    res.json({ message: "Test email sent", to });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/reminders/run-now", requireAuth, requireAdmin, async (req, res) => {
  try {
    res.json({ message: "Run-now triggered (implement send logic here)" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

/* ---------------------------
   Optional cron import usage
---------------------------- */
cron.schedule("0 9 25 * *", async () => {
  try {
    console.log("Monthly reminder cron checked");
  } catch (err) {
    console.error("Cron error:", err);
  }
});

module.exports = router;