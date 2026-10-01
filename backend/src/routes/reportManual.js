import express from "express";
import multer from "multer";
import { createTicket, linkAssetToTicket, attachDocumentsToTicket } from "../glpi.js";
import { uploadAttachments } from "../gcs.js";

const router = express.Router();

// Files are held in memory only long enough to stream to GCS — nothing
// touches local disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});

// POST /api/ticket/report-manual
// multipart/form-data fields:
//   title      - short summary (optional)
//   text       - issue description (required)
//   userId     - reporting user's GLPI id (required)
//   softwareId - the GLPI Software (app) id this ticket is about (required)
//   locationId - optional
//   files      - 0 or more attached files
router.post("/", upload.array("files", 10), async (req, res) => {
  try {
    const { title, text, userId, softwareId, locationId, developerId } = req.body;

    if (!text || !userId || !softwareId) {
      return res.status(400).json({ error: "userId, softwareId, and text are required." });
    }

    // 1. Create the ticket — no AI involved: everything comes straight
    //    from the user's own input, status defaults to New (1).
    const ticketPayload = {
      name: title || `[App report] ${softwareId}`,
      content: text,
      status: 1, // New
      _users_id_requester: userId,
      users_id_recipient: userId,
    };
    if (locationId) ticketPayload.locations_id = locationId;
    // Optional manual assignment — GLPI's Ticket::prepareInputForAdd reads
    // this field to auto-add an assigned-technician actor at creation time.
    if (developerId) ticketPayload._users_id_assign = developerId;

    const ticketResult = await createTicket(ticketPayload);
    if (!ticketResult || !ticketResult.id) {
      throw new Error("Failed to create ticket in GLPI.");
    }
    const ticketId = ticketResult.id;

    // 2. Link the reported app (Software) to the ticket.
    await linkAssetToTicket(ticketId, "Software", softwareId);

    // 3. Upload attachments to GCS, then create+link a GLPI Document per file.
    let attachments = [];
    if (req.files && req.files.length > 0) {
      const uploaded = await uploadAttachments(req.files, `ticket-${ticketId}`);
      attachments = await attachDocumentsToTicket(ticketId, uploaded);
    }

    res.json({
      success: true,
      ticketId: `OATH-2026-0${ticketId}`,
      rawTicketId: ticketId,
      status: "NEW",
      attachments, // [{ name, url, documentId }, ...]
    });
  } catch (error) {
    console.error("Error in /api/ticket/report-manual:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
