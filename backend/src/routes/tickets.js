import express from "express";
import { getTicketDetail } from "../glpi.js";

const router = express.Router();

// GET /api/tickets/:id
router.get("/:id", async (req, res) => {
  try {
    const detail = await getTicketDetail(req.params.id);
    res.json(detail);
  } catch (error) {
    console.error("Error in /api/tickets/:id:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;