// Cloudflare R2 client — S3-compatible object storage for ticket media
// (photos/videos of the physical device attached to a check-in ticket).
//
// R2 speaks the S3 API, so we use the standard AWS SDK v3 clients rather
// than a bespoke package. The only R2-specific bit is the endpoint, which
// is derived from the account ID (see R2_ACCOUNT_ID below).
//
// Required env vars:
//   R2_ACCOUNT_ID         Cloudflare account ID (dashboard right rail, or
//                         the first segment of the R2 S3 API endpoint).
//   R2_ACCESS_KEY_ID      From an R2 API token scoped to this bucket.
//   R2_SECRET_ACCESS_KEY  ditto.
//   R2_BUCKET_NAME        e.g. "jq-repair-media".
//   R2_PUBLIC_URL         Base URL objects are served from — either the
//                         bucket's r2.dev Public Development URL or a
//                         custom domain connected to the bucket. No
//                         trailing slash (stripped if present).
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function required(name, value) {
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

let client;
function r2Client() {
  if (!client) {
    const accountId = required("R2_ACCOUNT_ID", process.env.R2_ACCOUNT_ID);
    const accessKeyId = required("R2_ACCESS_KEY_ID", process.env.R2_ACCESS_KEY_ID);
    const secretAccessKey = required("R2_SECRET_ACCESS_KEY", process.env.R2_SECRET_ACCESS_KEY);
    client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      // Newer AWS SDK v3 versions attach a flexible-checksum (CRC32) query
      // param to presigned requests by default, computed as if the body
      // were empty (the SDK doesn't have the file bytes at presign time).
      // R2 checks that param against the real upload body and rejects the
      // mismatch, breaking presigned PUT uploads — this opts back out to
      // the old "only add a checksum when the API requires one" behavior.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }
  return client;
}

function bucketName() {
  return required("R2_BUCKET_NAME", process.env.R2_BUCKET_NAME);
}

function publicBaseUrl() {
  return required("R2_PUBLIC_URL", process.env.R2_PUBLIC_URL).replace(/\/+$/, "");
}

/** Public URL for an object key, given the bucket's configured base URL. */
export function r2PublicUrl(key) {
  return `${publicBaseUrl()}/${key}`;
}

/**
 * A short-lived presigned URL the browser can PUT the file bytes to
 * directly — keeps big videos off this app's Vercel functions (which have
 * a ~4.5MB body-size ceiling), same as the old Vercel Blob two-phase upload.
 */
export async function getUploadUrl(key, contentType, expiresIn = 300) {
  const command = new PutObjectCommand({
    Bucket: bucketName(),
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(r2Client(), command, { expiresIn });
}

/** Deletes an object by key. Throws on failure — callers decide how to handle it. */
export async function deleteObject(key) {
  await r2Client().send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
}
