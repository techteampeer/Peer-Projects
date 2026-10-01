import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Non-secret config values. Env vars always win if set — this file is
// just a fallback so values can be edited without touching Cloud Run's
// env var UI. Empty strings here mean "not configured yet".
export const PARAMS = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "config", "params.json"), "utf-8")
);
