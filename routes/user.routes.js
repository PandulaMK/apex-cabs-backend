const express = require("express");
const bcrypt = require("bcrypt");
const pool = require("../db");
const requireAuth = require("../middleware/auth");

const router = express.Router();

router.get("/me", requireAuth, async (req, res) => {
  try {
    const userId = req.user.user_id;

    const { rows } = await pool.query(
      "SELECT user_id, full_name, email, nic, address, phone_1, phone_2, role FROM users WHERE user_id = $1",
      [userId]
    );

    res.json(rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

router.put("/me", requireAuth, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { full_name, address, phone_1, phone_2 } = req.body;

    await pool.query(
      "UPDATE users SET full_name = $1, address = $2, phone_1 = $3, phone_2 = $4 WHERE user_id = $5",
      [full_name, address, phone_1, phone_2, userId]
    );

    const { rows } = await pool.query(
      "SELECT user_id, full_name, email, nic, address, phone_1, phone_2, role FROM users WHERE user_id = $1",
      [userId]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

router.put("/me/password", requireAuth, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const { currentPassword, newPassword } = req.body;

    const { rows } = await pool.query(
      "SELECT password_hash FROM users WHERE user_id = $1",
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({ message: "User not found" });
    }

    const ok = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!ok) {
      return res.status(400).json({ message: "Current password incorrect" });
    }

    const password_hash = await bcrypt.hash(newPassword, 10);

    await pool.query("UPDATE users SET password_hash = $1 WHERE user_id = $2", [
      password_hash,
      userId,
    ]);

    res.json({ message: "Password updated" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

router.post("/create-owner", requireAuth, requireAuth.requireAdmin, async (req, res) => {
  try {
    const { full_name, email, password, nic, phone_1, address } = req.body;

    if (!full_name || !email || !password || !nic) {
      return res.status(400).json({ message: "full_name, email, password, nic are required" });
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
      `INSERT INTO users (role, full_name, email, password_hash, nic, phone_1, address)
       VALUES ('owner', $1, $2, $3, $4, $5, $6)
       RETURNING user_id`,
      [full_name, email, password_hash, nic, phone_1 || null, address || null]
    );

    res.status(201).json({ message: "Owner created", owner_id: result.rows[0].user_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;