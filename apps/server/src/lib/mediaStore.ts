import path from "node:path";
import fs from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { env } from "../config/env";
import { UPLOADS_DIR } from "../modules/speech/edge-speech.service";

/**
 * Durable storage for generated lesson clips.
 *
 * These must NOT live under `uploads/`: `uploadsRetention.ts` deletes that
 * directory's contents after 24 hours, which is correct for throwaway narration
 * audio and catastrophic for a paid asset the whole student body is meant to
 * reuse for months.
 *
 * Three backends, chosen by `MEDIA_STORE`:
 *
 * - `r2` (recommended) — Cloudflare R2. Free tier is 10 GB-month storage and,
 *   crucially, **$0 egress at any volume**. A reuse library is egress-heavy by
 *   definition — every hit is a replay — so egress, not storage, is the meter
 *   that binds. ~4 MB per 8s 720p clip means 250 clips ≈ 1 GB.
 * - `cloudinary` — works, but its free tier allows roughly 1 GB of video
 *   bandwidth (~250 plays/month), which a reuse library will pass quickly.
 * - `local` — a `media/` directory beside `uploads/`, deliberately outside the
 *   retention sweep. Fine for development; it does not survive a redeploy on an
 *   ephemeral host, which is exactly why it is not the default for real use.
 */

export interface StoredMedia {
  url: string;
  bytes: number;
}

/** Local fallback directory — a sibling of uploads/, and never swept. */
export const MEDIA_DIR = path.join(UPLOADS_DIR, "..", "media");

function contentTypeFor(key: string): string {
  if (key.endsWith(".mp4")) return "video/mp4";
  if (key.endsWith(".webm")) return "video/webm";
  if (key.endsWith(".wav")) return "audio/wav";
  if (key.endsWith(".mp3")) return "audio/mpeg";
  if (key.endsWith(".m4a")) return "audio/mp4";
  return "application/octet-stream";
}

/* ── Cloudflare R2 (S3-compatible, SigV4) ────────────────────────────────────
 * Signed by hand rather than pulling in the AWS SDK: this is one PUT against
 * one bucket, and @aws-sdk/client-s3 is a large dependency to carry for it.
 */

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/**
 * Signs one S3/R2 request with AWS SigV4.
 *
 * Split out from any particular request so it can be exercised offline against
 * AWS's published test vectors. Hand-rolled signing is exactly the code that
 * looks right and fails on a single stray newline, and `*.cloudflarestorage.com`
 * is not reachable from every environment — so correctness must not depend on
 * being able to make a live call.
 *
 * Only the four headers below are ever signed, and they are already in the
 * lowercase-alphabetical order SigV4 demands (content-type, host,
 * x-amz-content-sha256, x-amz-date). Adding a signed header means re-sorting.
 */
export function signV4Request(params: {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  host: string;
  canonicalUri: string;
  /** Already-encoded query string, or "" — must be sorted by key for SigV4. */
  canonicalQuery?: string;
  contentType: string;
  payloadHash: string;
  amzDate: string; // YYYYMMDDTHHMMSSZ
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  service?: string;
}): { authorization: string; signature: string; canonicalRequest: string; stringToSign: string } {
  const region = params.region ?? "auto";
  const service = params.service ?? "s3";
  const dateStamp = params.amzDate.slice(0, 8);

  const canonicalHeaders =
    `content-type:${params.contentType}\n` +
    `host:${params.host}\n` +
    `x-amz-content-sha256:${params.payloadHash}\n` +
    `x-amz-date:${params.amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    params.method,
    params.canonicalUri,
    params.canonicalQuery ?? "",
    canonicalHeaders,
    signedHeaders,
    params.payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", params.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${params.secretAccessKey}`, dateStamp), region), service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signature,
    canonicalRequest,
    stringToSign,
  };
}

/** SigV4's timestamp format: YYYYMMDDTHHMMSSZ. */
export function amzDateNow(now = new Date()): string {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/**
 * Percent-encodes each path segment per RFC 3986, keeping the slashes between
 * them. An unencoded key produces a signature mismatch that surfaces as a
 * bewildering 403 rather than anything that names the real problem.
 */
export function encodeS3Path(segments: string[]): string {
  return (
    "/" +
    segments
      .map((seg) =>
        encodeURIComponent(seg).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()),
      )
      .join("/")
  );
}

/** Empty-body payload hash — the SHA-256 of "", which SigV4 requires for GET/HEAD. */
export const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Performs one signed R2 request. Shared by uploads and by the verify script,
 * so what the script proves is exactly what production runs.
 */
export async function r2Fetch(params: {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path segments after the host, e.g. [] for list-buckets, [bucket] or [bucket, key]. */
  segments: string[];
  body?: Buffer;
  contentType?: string;
}): Promise<Response> {
  const host = `${params.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = params.segments.length === 0 ? "/" : encodeS3Path(params.segments);
  const contentType = params.contentType ?? "application/octet-stream";
  const payloadHash = params.body ? sha256Hex(params.body) : EMPTY_PAYLOAD_SHA256;
  const amzDate = amzDateNow();

  const { authorization } = signV4Request({
    method: params.method,
    host,
    canonicalUri,
    contentType,
    payloadHash,
    amzDate,
    accessKeyId: params.accessKeyId,
    secretAccessKey: params.secretAccessKey,
  });

  return fetch(`https://${host}${canonicalUri}`, {
    method: params.method,
    headers: {
      "Content-Type": contentType,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      Authorization: authorization,
    },
    ...(params.body ? { body: new Uint8Array(params.body) } : {}),
  });
}

async function putToR2(key: string, body: Buffer): Promise<StoredMedia> {
  const { R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_PUBLIC_BASE_URL } = env;
  if (!R2_ACCOUNT_ID || !R2_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_PUBLIC_BASE_URL) {
    throw new Error(
      "MEDIA_STORE=r2 but configuration is incomplete — need account id, bucket, access key, secret and public base URL",
    );
  }

  const response = await r2Fetch({
    method: "PUT",
    accountId: R2_ACCOUNT_ID,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
    segments: [R2_BUCKET, key],
    body,
    contentType: contentTypeFor(key),
  });

  if (!response.ok) {
    throw new Error(`R2 upload failed: ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
  }

  return { url: `${R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}`, bytes: body.length };
}

/* ── Cloudinary (signed upload) ───────────────────────────────────────────── */

async function putToCloudinary(key: string, body: Buffer): Promise<StoredMedia> {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    throw new Error("MEDIA_STORE=cloudinary but CLOUDINARY_* environment variables are incomplete");
  }

  const publicId = key.replace(/\.[^.]+$/, "");
  const timestamp = Math.floor(Date.now() / 1000);
  // Cloudinary signs the alphabetically-sorted params, secret appended.
  const signature = sha256Hex(`public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`);

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(body)], { type: contentTypeFor(key) }), key);
  form.append("public_id", publicId);
  form.append("timestamp", String(timestamp));
  form.append("api_key", CLOUDINARY_API_KEY);
  form.append("signature", signature);

  // resource_type=video keeps it out of the image pipeline; we never request a
  // transformation, so only storage and bandwidth credits are consumed.
  const response = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/upload`, {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    throw new Error(
      `Cloudinary upload failed: ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`,
    );
  }

  const json = (await response.json()) as { secure_url?: string };
  if (!json.secure_url) throw new Error("Cloudinary upload returned no secure_url");
  return { url: json.secure_url, bytes: body.length };
}

/* ── Local (development) ──────────────────────────────────────────────────── */

async function putLocal(key: string, body: Buffer): Promise<StoredMedia> {
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await fs.writeFile(path.join(MEDIA_DIR, key), body);
  return { url: `/media/${key}`, bytes: body.length };
}

/**
 * Stores one media object durably and returns a URL the browser can fetch.
 * `key` should already be unique and carry a file extension.
 */
export async function putMedia(key: string, body: Buffer): Promise<StoredMedia> {
  switch (env.MEDIA_STORE) {
    case "r2":
      return putToR2(key, body);
    case "cloudinary":
      return putToCloudinary(key, body);
    default:
      return putLocal(key, body);
  }
}

/**
 * Reads back the bytes of something `putMedia` stored, by the URL it returned.
 * A local `/media/<key>` is read straight off disk (it is root-relative, so
 * there is nothing to fetch); anything else is a public object-store URL.
 */
export async function getMedia(url: string): Promise<Buffer> {
  if (url.startsWith("/media/")) {
    return fs.readFile(path.join(MEDIA_DIR, path.basename(url)));
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Media fetch failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** True when the configured backend actually has everything it needs to store a file. */
export function isMediaStoreConfigured(): boolean {
  if (env.MEDIA_STORE === "r2") {
    return Boolean(
      env.R2_ACCOUNT_ID && env.R2_BUCKET && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_PUBLIC_BASE_URL,
    );
  }
  if (env.MEDIA_STORE === "cloudinary") {
    return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
  }
  return true; // local always works
}
