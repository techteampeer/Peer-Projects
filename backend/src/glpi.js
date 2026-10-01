import fetch from "node-fetch";
import { PARAMS } from "./params.js";

// ============================================================
// GLPI client — config comes from environment variables first, with
// config/params.json as a fallback for non-secret values (so those can
// be edited later without touching Cloud Run's env var UI):
//   GLPI_BASE_URL           e.g. https://glpi.peer-consulting.com/apirest.php
//   GLPI_ENTITY_ID          falls back to params.entityId
//   GLPI_DEVELOPER_GROUP_ID falls back to params.developerGroupId
//   GLPI_APP_TOKEN          (secret, no fallback — must be set)
//   GLPI_USER_TOKEN         (secret, no fallback — must be set)
// ============================================================

const API_URL = process.env.GLPI_BASE_URL;
const APP_TOKEN = process.env.GLPI_APP_TOKEN;
const USER_TOKEN = process.env.GLPI_USER_TOKEN;
const ENTITY_ID = process.env.GLPI_ENTITY_ID || PARAMS.entityId || "1";

if (!API_URL || !APP_TOKEN || !USER_TOKEN) {
  console.warn(
    "[glpi.js] Missing one of GLPI_BASE_URL / GLPI_APP_TOKEN / GLPI_USER_TOKEN — GLPI calls will fail until these are set."
  );
}

/**
 * Fetches a URL and safely parses the body as JSON. Every GLPI call in
 * this file goes through here instead of raw fetch()+.json(), so a
 * non-JSON response (an HTML error page, a plain-text rights message, a
 * dropped session) always surfaces as a clear, labeled error — never as
 * a bare "Unexpected token" crash from an unguarded JSON.parse.
 *
 * @param {string} label - short description of the call, for error messages
 * @param {boolean} allowMissing - if true, a 404/non-ok response returns
 *   null instead of throwing (used for optional sub-resources)
 */
async function safeFetchJson(url, options, label, allowMissing = false) {
  const res = await fetch(url, options);
  const text = await res.text();

  if (!res.ok) {
    if (allowMissing) return null;
    throw new Error(`${label} failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!text) return allowMissing ? null : {};

  try {
    return JSON.parse(text);
  } catch {
    if (allowMissing) return null;
    throw new Error(`${label} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
}

/**
 * Initializes a session in GLPI and retrieves the active session token.
 * A fresh session is opened per call (no reuse) — same known trade-off
 * as the FDNY service; fine for current volume, worth revisiting if this
 * hits GLPI's per-API-user session limit under load.
 */
async function getSessionToken() {
  const data = await safeFetchJson(
    `${API_URL}/initSession`,
    { headers: { "App-Token": APP_TOKEN, Authorization: `user_token ${USER_TOKEN}` } },
    "GLPI initSession"
  );
  return data.session_token;
}

async function getHeaders() {
  const sessionToken = await getSessionToken();
  return {
    "App-Token": APP_TOKEN,
    "Session-Token": sessionToken,
    "Content-Type": "application/json",
    "Active-Entity": ENTITY_ID,
  };
}

/**
 * Identifies a user by login/badge and returns their full GLPI record.
 */
export async function identifyUser(identifier) {
  const headers = await getHeaders();
  const searchUrl = `${API_URL}/search/User?criteria[0][field]=1&criteria[0][searchtype]=equals&criteria[0][value]=${encodeURIComponent(identifier)}&forcedisplay[0]=2`;
  const data = await safeFetchJson(searchUrl, { headers }, "GLPI search/User");
  if (!data.data || data.data.length === 0) return null;
  const userId = data.data[0]["2"];
  return await safeFetchJson(`${API_URL}/User/${userId}`, { headers }, "GLPI User detail");
}

/**
 * Lists the Software catalog — this is the "apps" the frontend shows for
 * the user to pick from when reporting a ticket. Returns id/name/comment
 * for every Software item in the current entity.
 */
export async function listApps() {
  const headers = await getHeaders();
  // field 1 = name, field 16 = comment (GLPI's standard Software search fields)
  const url = `${API_URL}/search/Software?forcedisplay[0]=2&forcedisplay[1]=1&forcedisplay[2]=16&range=0-199`;
  const data = await safeFetchJson(url, { headers }, "GLPI search/Software");
  return (data.data || []).map((row) => ({
    id: row["2"],
    name: row["1"],
    description: row["16"] || "",
  }));
}

/**
 * Lists the members of a GLPI Group — used to populate the "assign to
 * developer" dropdown. Uses GLPI's native sub-item relation
 * (GET /Group/{id}/Group_User) instead of numeric search-option field
 * IDs, since those vary by GLPI instance/version and can't be guessed
 * reliably. Requires GLPI_DEVELOPER_GROUP_ID to be set to the real
 * GLPI id of the developers' group.
 */
export async function listDevelopers() {
  const groupId = process.env.GLPI_DEVELOPER_GROUP_ID || PARAMS.developerGroupId;
  if (!groupId) {
    console.warn(
      "[glpi.js] Developer group not configured — set GLPI_DEVELOPER_GROUP_ID or config/params.json.developerGroupId. /api/developers will return an empty list."
    );
    return [];
  }
  const headers = await getHeaders();
  const members = await safeFetchJson(`${API_URL}/Group/${groupId}/Group_User`, { headers }, "GLPI Group_User");

  const users = await Promise.all(
    (members || []).map(async (m) => {
      const u = await safeFetchJson(`${API_URL}/User/${m.users_id}`, { headers }, "GLPI User detail", true);
      if (!u) return null;
      const displayName = [u.firstname, u.realname].filter(Boolean).join(" ").trim() || u.name;
      return { id: u.id, name: displayName };
    })
  );
  return users.filter(Boolean);
}

/**
 * Creates a new Ticket in GLPI, scoped to the configured entity.
 */
export async function createTicket(payload) {
  const headers = await getHeaders();
  return await safeFetchJson(
    `${API_URL}/Ticket`,
    { method: "POST", headers, body: JSON.stringify({ input: { ...payload, entities_id: ENTITY_ID } }) },
    "GLPI create Ticket"
  );
}

/**
 * Links an asset (e.g. Software, Computer, Phone) to a Ticket.
 */
export async function linkAssetToTicket(ticketId, itemType, itemId) {
  const headers = await getHeaders();
  return await safeFetchJson(
    `${API_URL}/Item_Ticket`,
    { method: "POST", headers, body: JSON.stringify({ input: { tickets_id: ticketId, itemtype: itemType, items_id: itemId } }) },
    "GLPI link asset to Ticket"
  );
}

/**
 * Creates a GLPI Document pointing to an EXTERNAL link (a GCS object URL)
 * rather than uploading a binary into GLPI's own storage.
 */
export async function createDocument(name, link) {
  const headers = await getHeaders();
  return await safeFetchJson(
    `${API_URL}/Document`,
    { method: "POST", headers, body: JSON.stringify({ input: { name, link, entities_id: ENTITY_ID } }) },
    "GLPI create Document"
  );
}

/**
 * Links an existing Document to a Ticket via Document_Item.
 */
export async function linkDocumentToTicket(ticketId, documentId) {
  const headers = await getHeaders();
  return await safeFetchJson(
    `${API_URL}/Document_Item`,
    { method: "POST", headers, body: JSON.stringify({ input: { documents_id: documentId, itemtype: "Ticket", items_id: ticketId } }) },
    "GLPI link Document to Ticket"
  );
}

/**
 * Creates a Document + Document_Item for each {name, url} pair, all
 * linked to the given ticket. A ticket can have any number of these —
 * multiple attachments "just work" by calling this once per file.
 */
export async function attachDocumentsToTicket(ticketId, files) {
  const results = [];
  for (const f of files) {
    const doc = await createDocument(f.name, f.url);
    await linkDocumentToTicket(ticketId, doc.id);
    results.push({ name: f.name, url: f.url, documentId: doc.id });
  }
  return results;
}

// ============================================================
// Tickets — dashboard summary, recent list, and single-ticket detail.
// ============================================================

const STATUS_LABEL = { 1: "New", 2: "In Progress", 3: "In Progress", 4: "Pending", 5: "Resolved", 6: "Closed" };
const STATUS_BUCKET = { 1: "new", 2: "inProgress", 3: "inProgress", 4: "inProgress", 5: "resolved", 6: "resolved" };
const SCALE_LABEL = { 1: "Very Low", 2: "Low", 3: "Medium", 4: "High", 5: "Very High", 6: "Major" };

/** Resolves the Software (app) linked to a ticket via Item_Ticket, if any. */
async function resolveTicketApplication(ticketId, headers) {
  const links = await safeFetchJson(`${API_URL}/Ticket/${ticketId}/Item_Ticket`, { headers }, "GLPI Ticket Item_Ticket", true);
  const swLink = (Array.isArray(links) ? links : []).find((l) => l.itemtype === "Software");
  if (!swLink) return null;
  const sw = await safeFetchJson(`${API_URL}/Software/${swLink.items_id}`, { headers }, "GLPI Software detail", true);
  return sw ? sw.name || null : null;
}

/** Resolves requester and assigned-technician names via Ticket_User. */
async function resolveTicketActors(ticketId, headers) {
  const actors = await safeFetchJson(`${API_URL}/Ticket/${ticketId}/Ticket_User`, { headers }, "GLPI Ticket_User", true);
  const byType = (t) => (Array.isArray(actors) ? actors : []).find((a) => a.type === t);
  const requesterLink = byType(1); // 1 = Requester
  const assigneeLink = byType(2); // 2 = Assigned technician
  const nameFor = async (userId) => {
    if (!userId) return null;
    const u = await safeFetchJson(`${API_URL}/User/${userId}`, { headers }, "GLPI User detail", true);
    if (!u) return null;
    return [u.firstname, u.realname].filter(Boolean).join(" ").trim() || u.name || null;
  };
  return {
    requester: await nameFor(requesterLink && requesterLink.users_id),
    assignedTo: await nameFor(assigneeLink && assigneeLink.users_id),
  };
}

/** Resolves ITILFollowup entries into the frontend's {author, timestamp, message} activity shape. */
async function resolveTicketActivity(ticketId, headers) {
  const followups = await safeFetchJson(`${API_URL}/Ticket/${ticketId}/ITILFollowup`, { headers }, "GLPI ITILFollowup", true);
  const list = Array.isArray(followups) ? followups : [];
  return await Promise.all(
    list.map(async (f) => {
      let author = null;
      if (f.users_id) {
        const u = await safeFetchJson(`${API_URL}/User/${f.users_id}`, { headers }, "GLPI User detail", true);
        if (u) author = [u.firstname, u.realname].filter(Boolean).join(" ").trim() || u.name || null;
      }
      return { author, timestamp: f.date_creation, message: f.content };
    })
  );
}

/** Resolves attached documents via Document_Item, in the {name, url} shape gcs.js/glpi.js already use. */
async function resolveTicketAttachments(ticketId, headers) {
  const links = await safeFetchJson(`${API_URL}/Ticket/${ticketId}/Document_Item`, { headers }, "GLPI Ticket Document_Item", true);
  const list = Array.isArray(links) ? links : [];
  const docs = await Promise.all(
    list.map(async (l) => {
      const d = await safeFetchJson(`${API_URL}/Document/${l.documents_id}`, { headers }, "GLPI Document detail", true);
      return d ? { name: d.name, url: d.link } : null;
    })
  );
  return docs.filter(Boolean);
}

/**
 * Dashboard summary (counts by bucket) + the N most recently updated
 * tickets, mapped to the shape the frontend already expects:
 *   summary: { total, new, inProgress, resolved }
 *   recent:  [{ ticket, application, subject, status, updated }]
 */
export async function getDashboardData(limit = 10) {
  const headers = await getHeaders();

  // Use /search/Ticket (not the plain collection GET) so results are
  // scoped to the Active-Entity header — the same mechanism that already
  // correctly scopes listApps()/Software to this entity. We only ask
  // /search/ for the id (field 2 — the single most universal, already-
  // proven field across every itemtype in this instance) and then
  // hydrate each ticket with a plain GET /Ticket/{id}, which returns full
  // native fields (status, date_mod, entities_id, content…) without
  // guessing any more numeric search-option IDs.
  const searchData = await safeFetchJson(
    `${API_URL}/search/Ticket?forcedisplay[0]=2&range=0-299`,
    { headers },
    "GLPI search/Ticket"
  );
  const ids = (searchData.data || []).map((row) => row["2"]);

  const hydrated = await Promise.all(
    ids.map((id) => safeFetchJson(`${API_URL}/Ticket/${id}`, { headers }, `GLPI Ticket/${id} detail`, true))
  );

  // Belt-and-suspenders: even though /search/ should already be scoped to
  // the active entity, double-check against each ticket's own entities_id
  // in case that assumption doesn't hold on this instance either.
  const list = hydrated
    .filter(Boolean)
    .filter((t) => String(t.entities_id) === String(ENTITY_ID))
    .sort((a, b) => new Date(b.date_mod || 0) - new Date(a.date_mod || 0));

  const summary = { total: list.length, new: 0, inProgress: 0, resolved: 0 };
  for (const t of list) {
    const bucket = STATUS_BUCKET[t.status];
    if (bucket) summary[bucket] += 1;
  }

  const recentRaw = list.slice(0, limit);
  const recent = await Promise.all(
    recentRaw.map(async (t) => ({
      ticket: `OATH-2026-0${t.id}`,
      application: (await resolveTicketApplication(t.id, headers)) || "—",
      subject: t.name,
      status: STATUS_LABEL[t.status] || "Unknown",
      updated: t.date_mod,
    }))
  );

  // TEMPORARY — remove once entity scoping is confirmed working correctly.
  const _debug = {
    resolvedEntityId: ENTITY_ID,
    searchReturnedIds: ids.length,
    hydratedCount: hydrated.filter(Boolean).length,
    scopedCount: list.length,
    sample: hydrated.filter(Boolean).slice(0, 10).map((t) => ({ id: t.id, entities_id: t.entities_id, name: t.name })),
  };

  return { summary, recent, _debug };
}

/**
 * Full detail for one ticket, mapped to the shape renderIncidentDetail()
 * already expects (see frontend/public/index.html's documented contract).
 */
export async function getTicketDetail(ticketId) {
  const headers = await getHeaders();
  const t = await safeFetchJson(`${API_URL}/Ticket/${ticketId}`, { headers }, "GLPI Ticket detail");
  if (String(t.entities_id) !== String(ENTITY_ID)) {
    throw new Error("Ticket not found in this entity");
  }

  const [application, actors, activity, attachments] = await Promise.all([
    resolveTicketApplication(ticketId, headers),
    resolveTicketActors(ticketId, headers),
    resolveTicketActivity(ticketId, headers),
    resolveTicketAttachments(ticketId, headers),
  ]);

  return {
    ticketId: `OATH-2026-0${t.id}`,
    application: application || "—",
    title: t.name,
    status: STATUS_LABEL[t.status] || "Unknown",
    requester: actors.requester,
    assignedTo: actors.assignedTo,
    openedAt: t.date,
    updatedAt: t.date_mod,
    type: t.type === 2 ? "Request" : "Incident",
    urgency: SCALE_LABEL[t.urgency] || null,
    impact: SCALE_LABEL[t.impact] || null,
    priority: SCALE_LABEL[t.priority] || null,
    description: t.content,
    activity,
    attachments,
  };
}