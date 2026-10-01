import { Storage } from "@google-cloud/storage";

// POC: bucket is public. Production swaps this for an internal file server —
// see note at the bottom; nothing outside this file needs to change when it does.
const BUCKET_NAME = process.env.GCS_BUCKET_NAME;

if (!BUCKET_NAME) {
  console.warn("[gcs.js] GCS_BUCKET_NAME is not set — attachment uploads will fail until it is.");
}

// Application Default Credentials — no key file needed on Cloud Run, as
// long as the service's runtime service account has Storage Object Admin
// (or equivalent) on this bucket.
const storage = new Storage();
const bucket = () => storage.bucket(BUCKET_NAME);

/**
 * Uploads a single file buffer to the bucket under a ticket-scoped path
 * and returns its public URL.
 */
export async function uploadAttachment(buffer, originalName, mimeType, scope = "unscoped") {
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const gcsPath = `tickets/${scope}/${Date.now()}-${safeName}`;
  const file = bucket().file(gcsPath);

  await file.save(buffer, {
    contentType: mimeType,
    // Uniform bucket-level access is enabled on this bucket, so per-object
    // ACLs (the old `public: true` flag) are rejected outright. Public
    // read is instead granted once at the bucket level via IAM
    // (allUsers -> roles/storage.objectViewer) — every object inherits it
    // automatically, nothing per-upload needed here.
    resumable: false,
  });

  const url = `https://storage.googleapis.com/${BUCKET_NAME}/${gcsPath}`;
  return { name: originalName, url, gcsPath };
}

/** Uploads several files in parallel, preserving input order. */
export async function uploadAttachments(files, scope) {
  return Promise.all(files.map((f) => uploadAttachment(f.buffer, f.originalname, f.mimetype, scope)));
}

// ---------------------------------------------------------------------
// PRODUCTION NOTE: swapping to an internal file server keeps this module's
// interface identical (uploadAttachment/uploadAttachments, {name, url}
// return shape) — only the implementation body changes. glpi.js and the
// routes that call this never need to change for that swap.
// ---------------------------------------------------------------------