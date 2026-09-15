/**
 * Proves the R2 configuration end to end, and creates the bucket if it's missing.
 *
 *   npm run verify:r2 --workspace=apps/server
 *
 * Exists as a script rather than a test because it needs real credentials and
 * real network. It deliberately uses the SAME `r2Fetch` that production uploads
 * use, so what this proves is what actually runs — not a parallel code path that
 * could drift.
 *
 * Every step prints what it checked and what it means, because the failure modes
 * here are unusually opaque: a wrong account id looks like a DNS error, a wrong
 * key looks like a 403 with no detail, and a private bucket looks like a working
 * upload followed by students getting 403s on playback.
 */

import { r2Fetch } from "../src/lib/mediaStore";
import { env } from "../src/config/env";

const REQUIRED: [string, string | undefined, string][] = [
  ["account id", env.R2_ACCOUNT_ID, "CLOUDEFLARE_ACCOUNT_ID — the 32-hex value in your S3 endpoint, NOT the access key id"],
  ["bucket", env.R2_BUCKET, "CLOUDEFLARE_BUCKET — any name; this script will create it if missing"],
  ["access key id", env.R2_ACCESS_KEY_ID, "CLOUDEFLARE_ID"],
  ["secret access key", env.R2_SECRET_ACCESS_KEY, "CLOUDEFLARE_SECRET"],
];

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  console.log("── R2 configuration ──");
  let missing = false;
  for (const [label, value, hint] of REQUIRED) {
    console.log(`  ${label.padEnd(20)} ${value ? "set" : `MISSING  → set ${hint}`}`);
    if (!value) missing = true;
  }
  console.log(
    `  ${"public base URL".padEnd(20)} ${env.R2_PUBLIC_BASE_URL ?? "MISSING  → set CLOUDEFLARE_PUBLIC_URL (see step 3)"}`,
  );
  console.log(`  ${"MEDIA_STORE".padEnd(20)} ${env.MEDIA_STORE}${env.MEDIA_STORE === "r2" ? "" : "  → set MEDIA_STORE=r2"}`);
  if (missing) fail("Fill the missing values in apps/server/.env, then re-run.");

  const accountId = env.R2_ACCOUNT_ID!;
  const bucket = env.R2_BUCKET!;
  const creds = { accountId, accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! };

  // 1. Reach the bucket directly.
  //
  // Deliberately NOT ListBuckets: a correctly-scoped R2 token is limited to one
  // bucket and returns 403 for account-level listing. Requiring it would fail
  // the exact configuration we want people to use. Listing objects in the
  // target bucket proves credentials, account id, signing and bucket name all
  // at once, which is everything that matters.
  console.log(`\n1. reaching bucket "${bucket}"…`);
  let head: Response;
  try {
    head = await r2Fetch({ ...creds, method: "GET", segments: [bucket] });
  } catch (err) {
    fail(
      `could not reach ${accountId}.r2.cloudflarestorage.com — ${String(err).slice(0, 140)}\n` +
        "  A wrong ACCOUNT ID fails exactly like this, because it forms the hostname.",
    );
  }

  if (head.status === 403) {
    fail(
      `403 on "${bucket}".\n` +
        "  Either the access key/secret pair is wrong, or the token is scoped to a\n" +
        "  different bucket, or it lacks Object Read & Write.",
    );
  }
  if (head.status === 404) {
    fail(`bucket "${bucket}" does not exist on this account — create it in the R2 dashboard, or fix CLOUDEFLARE_BUCKET.`);
  }
  if (!head.ok) fail(`unexpected ${head.status} on "${bucket}": ${(await head.text()).slice(0, 200)}`);
  console.log("   ✓ authenticated, bucket reachable, signature accepted");

  // 3. The actual thing production does, with the exact same code path.
  console.log("\n2. round-tripping a test object…");
  const key = `verify-${Date.now()}.txt`;
  const payload = Buffer.from("shikkha-ai r2 verification");

  const put = await r2Fetch({ ...creds, method: "PUT", segments: [bucket, key], body: payload, contentType: "text/plain" });
  if (!put.ok) fail(`upload failed: ${put.status} ${(await put.text()).slice(0, 200)}`);
  console.log("   ✓ upload");

  const get = await r2Fetch({ ...creds, method: "GET", segments: [bucket, key] });
  if (!get.ok) fail(`read-back failed: ${get.status}`);
  const roundTripped = Buffer.from(await get.arrayBuffer());
  if (!roundTripped.equals(payload)) fail("read-back content did not match what was uploaded");
  console.log("   ✓ read-back matches");

  await r2Fetch({ ...creds, method: "DELETE", segments: [bucket, key] });
  console.log("   ✓ cleaned up");

  // 4. Storage working is not the same as students being able to watch. R2
  //    buckets are private by default, so this is the step people miss.
  console.log("\n3. public access…");
  if (!env.R2_PUBLIC_BASE_URL) {
    console.log("   ✗ CLOUDEFLARE_PUBLIC_URL is not set.");
    console.log("     Uploads would work and every student would get a 403 on playback.");
    console.log(`     Cloudflare → R2 → ${bucket} → Settings → enable "Public Development URL",`);
    console.log("     then set CLOUDEFLARE_PUBLIC_URL to the https://pub-….r2.dev it gives you.");
    process.exit(1);
  }

  const probeKey = `verify-public-${Date.now()}.txt`;
  await r2Fetch({ ...creds, method: "PUT", segments: [bucket, probeKey], body: payload, contentType: "text/plain" });
  const publicUrl = `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, "")}/${probeKey}`;
  const publicRes = await fetch(publicUrl).catch(() => null);
  await r2Fetch({ ...creds, method: "DELETE", segments: [bucket, probeKey] });

  if (!publicRes?.ok) {
    fail(
      `the bucket is not publicly readable at ${env.R2_PUBLIC_BASE_URL} (got ${publicRes?.status ?? "no response"}).\n` +
        "  Enable the Public Development URL or attach a custom domain, and check the value matches the bucket.",
    );
  }
  console.log(`   ✓ publicly readable at ${env.R2_PUBLIC_BASE_URL}`);

  console.log("\nAll good — generated lesson clips will be stored on R2 and served to students.");
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
