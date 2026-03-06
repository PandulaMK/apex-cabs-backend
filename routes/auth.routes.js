const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../db");

const router = express.Router();

// Register (Customer)
router.post("/register", async (req, res) => {
  try {
    const { full_name, email, password, nic } = req.body;

    if (!full_name || !email || !password || !nic) {
      return res.status(400).json({ message: "Missing fields" });
    }

    const { rows: exists } = await pool.query(
      "SELECT user_id FROM users WHERE email = $1 OR nic = $2",
      [email, nic]
    );

    if (exists.length) {
      return res.status(409).json({ message: "User already exists" });
    }

    const password_hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `
      INSERT INTO users (role, full_name, email, password_hash, nic)
      VALUES ('customer', $1, $2, $3, $4)
      RETURNING user_id
      `,
      [full_name, email, password_hash, nic]
    );

    res.json({ message: "Registered", user_id: result.rows[0].user_id });
  } catch (e) {
    console.error("Register error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

// Login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Missing fields" });
    }

    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email]);

    if (!rows.length) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);

    if (!ok) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { user_id: user.user_id, role: user.role, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: {
        user_id: user.user_id,
        role: user.role,
        full_name: user.full_name,
        email: user.email,
      },
    });
  } catch (e) {
    console.error("Login error:", e);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;