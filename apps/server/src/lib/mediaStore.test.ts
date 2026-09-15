import { describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { amzDateNow, encodeS3Path, signV4Request, EMPTY_PAYLOAD_SHA256 } from "./mediaStore";

/**
 * `*.cloudflarestorage.com` is not reachable from every environment, so the
 * correctness of this signing cannot rest on making a live call. These tests
 * pin it against AWS's own documented algorithm instead — an independent
 * re-derivation here, plus the invariants that a wrong signature would break.
 *
 * A bad signature surfaces from R2 as an opaque 403 that names nothing, which
 * is precisely why it is worth proving offline.
 */

const CREDS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

describe("EMPTY_PAYLOAD_SHA256", () => {
  it("is genuinely the SHA-256 of an empty body", () => {
    expect(EMPTY_PAYLOAD_SHA256).toBe(createHash("sha256").update("").digest("hex"));
  });
});

describe("amzDateNow", () => {
  it("emits SigV4's YYYYMMDDTHHMMSSZ, with no separators or milliseconds", () => {
    expect(amzDateNow(new Date("2026-09-10T05:33:21.472Z"))).toBe("20260910T053321Z");
  });

  it("produces a date stamp that is the first 8 characters", () => {
    expect(amzDateNow(new Date("2026-01-02T03:04:05.000Z")).slice(0, 8)).toBe("20260102");
  });
});

describe("encodeS3Path", () => {
  it("keeps slashes between segments but encodes within them", () => {
    expect(encodeS3Path(["bucket", "lesson-abc.mp4"])).toBe("/bucket/lesson-abc.mp4");
    expect(encodeS3Path(["bucket", "a b.mp4"])).toBe("/bucket/a%20b.mp4");
  });

  it("encodes the characters encodeURIComponent leaves alone but SigV4 does not", () => {
    // These four are the classic source of signature mismatches.
    expect(encodeS3Path(["b", "x!'()*.mp4"])).toBe("/b/x%21%27%28%29%2A.mp4");
  });

  it("returns a rooted path for a single segment", () => {
    expect(encodeS3Path(["only"])).toBe("/only");
  });
});

describe("signV4Request", () => {
  const base = {
    method: "PUT" as const,
    host: "acct.r2.cloudflarestorage.com",
    canonicalUri: "/bucket/key.mp4",
    contentType: "video/mp4",
    payloadHash: "abc123",
    amzDate: "20260910T053321Z",
    ...CREDS,
  };

  it("builds the canonical request exactly as SigV4 specifies", () => {
    const { canonicalRequest } = signV4Request(base);

    // Method \n URI \n query \n canonical headers \n signed headers \n payload hash.
    // Note the blank line: canonical headers end with their own trailing \n,
    // and the block is then separated from signedHeaders by another.
    expect(canonicalRequest).toBe(
      [
        "PUT",
        "/bucket/key.mp4",
        "",
        "content-type:video/mp4",
        "host:acct.r2.cloudflarestorage.com",
        "x-amz-content-sha256:abc123",
        "x-amz-date:20260910T053321Z",
        "",
        "content-type;host;x-amz-content-sha256;x-amz-date",
        "abc123",
      ].join("\n"),
    );
  });

  it("builds the string-to-sign from the canonical request's hash", () => {
    const { canonicalRequest, stringToSign } = signV4Request(base);

    expect(stringToSign).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20260910T053321Z",
        "20260910/auto/s3/aws4_request",
        createHash("sha256").update(canonicalRequest).digest("hex"),
      ].join("\n"),
    );
  });

  it("derives the signing key through the documented four-step HMAC chain", () => {
    const { stringToSign, signature } = signV4Request(base);

    // Independent re-derivation: kDate -> kRegion -> kService -> kSigning.
    const h = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();
    const kDate = h(`AWS4${CREDS.secretAccessKey}`, "20260910");
    const kRegion = h(kDate, "auto");
    const kService = h(kRegion, "s3");
    const kSigning = h(kService, "aws4_request");
    const expected = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

    expect(signature).toBe(expected);
  });

  it("emits an Authorization header in the exact form S3 parses", () => {
    const { authorization, signature } = signV4Request(base);

    expect(authorization).toBe(
      "AWS4-HMAC-SHA256 " +
        "Credential=AKIDEXAMPLE/20260910/auto/s3/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, " +
        `Signature=${signature}`,
    );
  });

  it("uses R2's 'auto' region by default", () => {
    expect(signV4Request(base).authorization).toContain("/auto/s3/aws4_request");
  });

  it("signs headers in lowercase-alphabetical order, which SigV4 requires", () => {
    const headerLines = signV4Request(base)
      .canonicalRequest.split("\n")
      .slice(3, 7)
      .map((l) => l.split(":")[0]!);

    expect(headerLines).toEqual([...headerLines].sort());
  });

  // Each of these must change the signature, or the signature isn't actually
  // covering the request and a tampered upload would still authenticate.
  it("changes the signature when any signed component changes", () => {
    const baseline = signV4Request(base).signature;

    expect(signV4Request({ ...base, method: "GET" }).signature).not.toBe(baseline);
    expect(signV4Request({ ...base, canonicalUri: "/bucket/other.mp4" }).signature).not.toBe(baseline);
    expect(signV4Request({ ...base, payloadHash: "different" }).signature).not.toBe(baseline);
    expect(signV4Request({ ...base, contentType: "text/plain" }).signature).not.toBe(baseline);
    expect(signV4Request({ ...base, amzDate: "20260911T053321Z" }).signature).not.toBe(baseline);
    expect(signV4Request({ ...base, host: "other.r2.cloudflarestorage.com" }).signature).not.toBe(baseline);
    expect(signV4Request({ ...base, secretAccessKey: "different" }).signature).not.toBe(baseline);
  });

  it("is deterministic for identical inputs", () => {
    expect(signV4Request(base).signature).toBe(signV4Request(base).signature);
  });

  it("includes a query string in the canonical request when one is given", () => {
    const withQuery = signV4Request({ ...base, method: "GET", canonicalQuery: "list-type=2" });
    expect(withQuery.canonicalRequest.split("\n")[2]).toBe("list-type=2");
  });
});
