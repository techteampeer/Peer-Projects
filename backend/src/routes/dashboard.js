import express from "express";
import { getDashboardData } from "../glpi.js";

const router = express.Router();

// GET /api/dashboard
router.get("/", async (req, res) => {
  try {
    const data = await getDashboardData();
    res.json(data);
  } catch (error) {
    console.error("Error in /api/dashboard:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;