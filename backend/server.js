import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import appsRoute from "./src/routes/apps.js";
import developersRoute from "./src/routes/developers.js";
import reportManualRoute from "./src/routes/reportManual.js";
import dashboardRoute from "./src/routes/dashboard.js";
import ticketsRoute from "./src/routes/tickets.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. API routes — must come before the static/catch-all below
app.get("/api/health", (req, res) => res.json({ ok: true }));
app.use("/api/apps", appsRoute);
app.use("/api/developers", developersRoute);
app.use("/api/ticket/report-manual", reportManualRoute);
app.use("/api/dashboard", dashboardRoute);
app.use("/api/tickets", ticketsRoute);

// 2. Serve the built frontend (copied into ./public by the Dockerfile)
const frontendPath = path.join(__dirname, "public");
app.use(express.static(frontendPath));

// 3. SPA catch-all — everything that isn't /api/* falls back to index.html
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(frontendPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`OATH backend running on port ${PORT}`);
});