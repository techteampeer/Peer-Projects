import express from "express";
import { listApps } from "../glpi.js";

const router = express.Router();

// GET /api/apps
router.get("/", async (req, res) => {
  try {
    const apps = await listApps();
    res.json({ apps });
  } catch (error) {
    console.error("Error in /api/apps:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
