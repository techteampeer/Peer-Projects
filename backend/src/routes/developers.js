import express from "express";
import { listDevelopers } from "../glpi.js";

const router = express.Router();

// GET /api/developers
router.get("/", async (req, res) => {
  try {
    const developers = await listDevelopers();
    res.json({ developers });
  } catch (error) {
    console.error("Error in /api/developers:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
