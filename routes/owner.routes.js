const express = require("express");
const pool = require("../db");
const requireAuth = require("../middleware/auth");

const fs = require("fs");
const path = require("path");
const multer = require("multer"); // ✅ ADD THIS

const router = express.Router();
// OWNER DASHBOARD STATS
router.get("/stats", requireAuth, requireAuth.requireOwner, async (req, res) => {
  try {
    const ownerId = req.user.user_id;

    const { rows: activeRows } = await pool.query(
  `SELECT COUNT(*)::int AS "activeRentals"
   FROM bookings b
   JOIN vehicles v ON v.vehicle_id = b.vehicle_id
   WHERE v.owner_id = $1
     AND b.booking_status = 'confirmed'
     AND CURRENT_DATE BETWEEN b.rental_date::date AND b.return_date::date`,
  [ownerId]
);

const { rows: pendingRows } = await pool.query(
  `SELECT COUNT(*)::int AS "pendingPayments"
   FROM bookings b
   JOIN vehicles v ON v.vehicle_id = b.vehicle_id
   WHERE v.owner_id = $1
     AND b.booking_status = 'confirmed'
     AND (b.advance_paid IS NULL OR b.advance_paid = FALSE)`,
  [ownerId]
);

const { rows: maintRows } = await pool.query(
  `SELECT COUNT(*)::int AS "dueForMaintenance"
   FROM vehicles v
   WHERE v.owner_id = $1
     AND (
       v.status = 'maintenance'
       OR (v.current_mileage >= v.next_service_mileage)
     )`,
  [ownerId]
);

    res.json({
      activeRentals: activeRows[0].activeRentals || 0,
      pendingPayments: pendingRows[0].pendingPayments || 0,
      dueForMaintenance: maintRows[0].dueForMaintenance || 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});



// ensure folder


const uploadDir = path.join(__dirname, "..", "uploads", "vehicles");
fs.mkdirSync(uploadDir, { recursive: true });

// multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `veh_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB
  fileFilter: (req, file, cb) => {
    const ok = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("Only PNG/JPG/WEBP allowed"), ok);
  },
});

// GET owner vehicles
router.get("/vehicles", requireAuth, requireAuth.requireOwner, async (req, res) => {
  const ownerId = req.user.user_id;
  const search = (req.query.search || "").trim();

  const whereSearch = search
  ? `AND (title ILIKE $2 OR vehicle_number ILIKE $3 OR vehicle_type ILIKE $4)`
  : "";

const params = search
  ? [ownerId, `%${search}%`, `%${search}%`, `%${search}%`]
  : [ownerId];

const { rows } = await pool.query(
  `
  SELECT vehicle_id, title, vehicle_number, vehicle_type, transmission, fuel_type,
         daily_rate, status, current_mileage, next_service_mileage, image_path
  FROM vehicles
  WHERE owner_id = $1
  ${whereSearch}
  ORDER BY vehicle_id DESC
  `,
  params
);

  res.json(rows);
});

// POST owner vehicle (with image upload)
router.post(
  "/vehicles",
  requireAuth,
  requireAuth.requireOwner,
  upload.single("image"),
  async (req, res) => {
    try {
      // multer ensures req.body exists for multipart/form-data
      const title = req.body?.title;
      const vehicle_number = req.body?.vehicle_number;
      const vehicle_type = req.body?.vehicle_type;
      const transmission = req.body?.transmission || "auto";
      const fuel_type = req.body?.fuel_type || "petrol";

      const current_mileage = Number(req.body?.current_mileage || 0);
      const last_service_mileage = Number(req.body?.last_service_mileage || 0);
      const service_interval = Number(req.body?.service_interval || 5000);
      const next_service_mileage = Number(req.body?.next_service_mileage || 5000);

      if (!title || !vehicle_number || !vehicle_type) {
        return res.status(400).json({ message: "Title, Vehicle Number, Vehicle Type are required" });
      }

      const ownerId = req.user.user_id;

      const image_path = req.file ? `/uploads/vehicles/${req.file.filename}` : null;

      await pool.query(
  `INSERT INTO vehicles
    (owner_id, title, vehicle_number, vehicle_type, transmission, fuel_type,
     daily_rate, status, image_path,
     current_mileage, last_service_mileage, service_interval, next_service_mileage)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
  [
    ownerId,
    title,
    vehicle_number,
    vehicle_type,
    transmission,
    fuel_type,
    0,
    "pending",
    image_path,
    current_mileage,
    last_service_mileage,
    service_interval,
    next_service_mileage,
  ]
);

      res.status(201).json({ message: "Vehicle submitted (pending admin approval)" });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error" });
    }
  }
);

// OWNER BOOKINGS (view only)
router.get("/bookings", requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.user_id;
    const search = String(req.query.search || "").trim();

    let query = `
      SELECT
        b.booking_id,
        v.vehicle_number,
        v.title AS vehicle_title,
        u.full_name AS customer_name,
        u.email AS customer_email,
        TO_CHAR(b.rental_date::date, 'YYYY-MM-DD') AS rental_date,
        TO_CHAR(b.return_date::date, 'YYYY-MM-DD') AS return_date,
        b.booking_status,
        b.advance_paid,
        b.advance_amount,
        b.advance_paid_at
      FROM bookings b
      JOIN vehicles v ON v.vehicle_id = b.vehicle_id
      JOIN users u ON u.user_id = b.customer_id
      WHERE v.owner_id = $1
    `;

    const params = [ownerId];

    if (search) {
      query += `
        AND (
          v.vehicle_number ILIKE $2 OR
          b.booking_status ILIKE $3 OR
          u.full_name ILIKE $4 OR
          u.email ILIKE $5
        )
      `;
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    query += ` ORDER BY b.booking_id DESC`;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

router.get("/payments", requireAuth, requireAuth.requireOwner, async (req, res) => {
  try {
    const ownerId = req.user.user_id;

    const monthStr = (req.query.month || "").trim();
    const now = new Date();
    const fallbackMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const finalMonth = monthStr || fallbackMonth;
    const monthStart = `${finalMonth}-01`; // YYYY-MM-01

    const { rows } = await pool.query(
  `
  SELECT 
    v.vehicle_id,
    v.vehicle_number,
    v.title,
    v.daily_rate,

    op.amount AS payout_amount,
    op.status AS payout_status,
    op.paid_at,

    COALESCE(SUM(
      CASE 
        WHEN b.booking_status = 'confirmed'
         AND TO_CHAR(b.rental_date::date, 'YYYY-MM-01') = $1
        THEN (COALESCE(v.daily_rate, 0) * ((b.return_date::date - b.rental_date::date) + 1))
        ELSE 0
      END
    ), 0) AS gross_amount,

    ROUND((
      COALESCE(SUM(
        CASE 
          WHEN b.booking_status = 'confirmed'
           AND TO_CHAR(b.rental_date::date, 'YYYY-MM-01') = $1
          THEN (COALESCE(v.daily_rate, 0) * ((b.return_date::date - b.rental_date::date) + 1))
          ELSE 0
        END
      ), 0) * 0.85
    )::numeric, 2) AS owner_amount,

    ROUND((
      COALESCE(SUM(
        CASE 
          WHEN b.booking_status = 'confirmed'
           AND TO_CHAR(b.rental_date::date, 'YYYY-MM-01') = $1
          THEN (COALESCE(v.daily_rate, 0) * ((b.return_date::date - b.rental_date::date) + 1))
          ELSE 0
        END
      ), 0) * 0.15
    )::numeric, 2) AS company_amount,

    SUM(
      CASE
        WHEN b.booking_status = 'confirmed'
         AND TO_CHAR(b.rental_date::date, 'YYYY-MM-01') = $1
        THEN 1 ELSE 0
      END
    ) AS bookings_count

  FROM vehicles v
  LEFT JOIN owner_payments op
    ON op.vehicle_id = v.vehicle_id
   AND op.owner_id = v.owner_id
   AND op.pay_month = $2
  LEFT JOIN bookings b
    ON b.vehicle_id = v.vehicle_id
  WHERE v.owner_id = $3
  GROUP BY 
    v.vehicle_id, v.vehicle_number, v.title, v.daily_rate,
    op.amount, op.status, op.paid_at
  ORDER BY v.vehicle_number ASC
  `,
  [monthStart, monthStart, ownerId]
);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// OWNER MAINTENANCE LIST
router.get("/maintenance", requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.user_id;
    const search = String(req.query.search || "").trim();

    let query = `
      SELECT
        v.vehicle_id,
        v.vehicle_number,
        v.title AS vehicle_title,
        v.current_mileage,
        v.next_service_mileage,
        CASE
          WHEN v.current_mileage >= v.next_service_mileage THEN 'DUE'
          ELSE 'OK'
        END AS status
      FROM vehicles v
      WHERE v.owner_id = $1
    `;

    const params = [ownerId];

    if (search) {
      const like = `%${search}%`;
      query += `
        AND (
          v.title ILIKE $2 OR
          v.vehicle_number ILIKE $3
        )
      `;
      params.push(like, like);
    }

    query += `
      ORDER BY
        (v.current_mileage >= v.next_service_mileage) DESC,
        v.vehicle_id DESC
    `;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// OWNER MAINTENANCE UPDATE (service done)
router.put("/maintenance/:vehicleId", requireAuth, requireAuth.requireOwner, async (req, res) => {
  try {
    const ownerId = req.user.user_id;
    const vehicleId = Number(req.params.vehicleId);

    const newMileage = Number(req.body.current_mileage);
    const setAvailable = req.body.set_available === true || req.body.set_available === "true";
    const note = (req.body.note || "").trim();

    if (!vehicleId || !Number.isFinite(newMileage) || newMileage < 0) {
      return res.status(400).json({ message: "Valid current_mileage is required" });
    }

    // ensure this vehicle belongs to owner
    const { rows: vrows } = await pool.query(
  `SELECT vehicle_id, current_mileage, service_interval
   FROM vehicles
   WHERE vehicle_id = $1 AND owner_id = $2
   LIMIT 1`,
  [vehicleId, ownerId]
);
    if (vrows.length === 0) return res.status(404).json({ message: "Vehicle not found" });

    const interval = Number(vrows[0].service_interval || 5000);

    const lastServiceMileage = newMileage;
    const nextServiceMileage = newMileage + interval;

    // update vehicle
    await pool.query(
  `
  UPDATE vehicles
  SET current_mileage = $1,
      last_service_mileage = $2,
      next_service_mileage = $3,
      status = CASE WHEN $4 THEN 'available' ELSE status END
  WHERE vehicle_id = $5 AND owner_id = $6
  `,
  [newMileage, lastServiceMileage, nextServiceMileage, setAvailable, vehicleId, ownerId]
);

await pool.query(
  `
  INSERT INTO maintenance_updates
    (vehicle_id, owner_id, updated_by, current_mileage, next_service_mileage, note)
  VALUES ($1, $2, $3, $4, $5, $6)
  `,
  [vehicleId, ownerId, ownerId, newMileage, nextServiceMileage, note || null]
);
    res.json({ message: "Maintenance updated", next_service_mileage: nextServiceMileage });
  } catch (err) {
    console.error(err);
    // if maintenance_updates column mismatch, you’ll see SQL error—then paste DESCRIBE maintenance_updates
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;