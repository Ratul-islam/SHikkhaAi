import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepStaleUploads } from "./uploadsRetention";

const RETENTION_MS = 24 * 60 * 60 * 1000;

describe("sweepStaleUploads", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "shikkha-uploads-test-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("deletes a file older than the retention window and keeps a fresh one", async () => {
    await fs.writeFile(path.join(dir, "old.mp3"), "x");
    await fs.writeFile(path.join(dir, "new.mp3"), "x");
    const oldTime = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    await fs.utimes(path.join(dir, "old.mp3"), oldTime, oldTime);

    const deleted = await sweepStaleUploads(dir, RETENTION_MS);

    expect(deleted).toBe(1);
    const remaining = await fs.readdir(dir);
    expect(remaining).toEqual(["new.mp3"]);
  });

  it("deletes nothing when every file is fresh", async () => {
    await fs.writeFile(path.join(dir, "a.mp3"), "x");
    await fs.writeFile(path.join(dir, "b.mp3"), "x");

    const deleted = await sweepStaleUploads(dir, RETENTION_MS);

    expect(deleted).toBe(0);
    expect((await fs.readdir(dir)).length).toBe(2);
  });

  it("returns 0 for a directory that doesn't exist yet, rather than throwing", async () => {
    const missing = path.join(dir, "does-not-exist");
    await expect(sweepStaleUploads(missing, RETENTION_MS)).resolves.toBe(0);
  });
});
