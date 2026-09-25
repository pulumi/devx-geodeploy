import { describe, expect, it } from "vitest";
import { collectFilesFromDataTransferItems, containsDirectory, encodeFilesForUpload, findDockerfilePath, shouldIgnorePath } from "./folderUpload";

describe("shouldIgnorePath", () => {
  it("ignores files inside node_modules at any depth", () => {
    expect(shouldIgnorePath("node_modules/left-pad/index.js")).toBe(true);
    expect(shouldIgnorePath("app/node_modules/left-pad/index.js")).toBe(true);
  });

  it("ignores .git, dist, build, .next, venv, __pycache__ directories", () => {
    expect(shouldIgnorePath(".git/HEAD")).toBe(true);
    expect(shouldIgnorePath("dist/index.js")).toBe(true);
    expect(shouldIgnorePath("build/out.js")).toBe(true);
    expect(shouldIgnorePath(".next/cache/x")).toBe(true);
    expect(shouldIgnorePath("venv/lib/x.py")).toBe(true);
    expect(shouldIgnorePath("app/__pycache__/x.pyc")).toBe(true);
  });

  it("ignores .DS_Store as a filename but not as a directory name", () => {
    expect(shouldIgnorePath(".DS_Store")).toBe(true);
    expect(shouldIgnorePath("src/.DS_Store")).toBe(true);
  });

  it("does not ignore ordinary project files", () => {
    expect(shouldIgnorePath("Dockerfile")).toBe(false);
    expect(shouldIgnorePath("src/index.js")).toBe(false);
    expect(shouldIgnorePath("package.json")).toBe(false);
    // A file merely named similarly to an ignored dir shouldn't match.
    expect(shouldIgnorePath("distribution/notes.txt")).toBe(false);
  });
});

describe("findDockerfilePath", () => {
  it("finds a Dockerfile at the root", () => {
    const result = findDockerfilePath([{ relativePath: "Dockerfile" }, { relativePath: "src/index.js" }]);
    expect(result).toBe("Dockerfile");
  });

  it("finds Dockerfile.<ext> variants case-insensitively", () => {
    expect(findDockerfilePath([{ relativePath: "dockerfile.prod" }])).toBe("dockerfile.prod");
  });

  it("returns the shallowest match when several Dockerfiles exist", () => {
    const result = findDockerfilePath([
      { relativePath: "a/b/c/Dockerfile" },
      { relativePath: "a/Dockerfile" },
      { relativePath: "a/b/Dockerfile" },
    ]);
    expect(result).toBe("a/Dockerfile");
  });

  it("returns null when no Dockerfile is present", () => {
    expect(findDockerfilePath([{ relativePath: "README.md" }, { relativePath: "src/index.js" }])).toBeNull();
  });
});

describe("encodeFilesForUpload", () => {
  it("round-trips a small text file's content through base64", async () => {
    const file = new File(["FROM node:20\n"], "Dockerfile", { type: "text/plain" });
    const [encoded] = await encodeFilesForUpload([{ file, relativePath: "Dockerfile" }]);
    expect(encoded!.path).toBe("Dockerfile");
    expect(Buffer.from(encoded!.contentBase64, "base64").toString("utf8")).toBe("FROM node:20\n");
  });

  it("preserves each entry's relativePath, not the File's own name", async () => {
    const file = new File(["x"], "Dockerfile", { type: "text/plain" });
    const [encoded] = await encodeFilesForUpload([{ file, relativePath: "app/Dockerfile" }]);
    expect(encoded!.path).toBe("app/Dockerfile");
  });
});

// Regression test for a real bug found via live user testing: a folder
// dropped in Firefox produced "Could not read that file" because directory
// detection only ever checked `webkitGetAsEntry`, which some Firefox
// versions don't implement (only the earlier unprefixed `getAsEntry`) — so
// every folder drop silently fell through to the single-file path. These
// fakes expose ONLY `getAsEntry`, never `webkitGetAsEntry`, to lock in the
// fallback.
describe("directory detection falls back to the unprefixed getAsEntry", () => {
  interface FakeEntry {
    isDirectory: boolean;
    isFile: boolean;
    fullPath: string;
    createReader?: () => { readEntries: (cb: (entries: FakeEntry[]) => void) => void };
    file?: (cb: (f: File) => void) => void;
  }

  function fakeFileEntry(fullPath: string, contents: string): FakeEntry {
    return {
      isDirectory: false,
      isFile: true,
      fullPath,
      file: (cb) => cb(new File([contents], fullPath.split("/").pop()!)),
    };
  }

  function fakeDirEntry(fullPath: string, children: FakeEntry[]): FakeEntry {
    let delivered = false;
    return {
      isDirectory: true,
      isFile: false,
      fullPath,
      createReader: () => ({
        // Flip `delivered` BEFORE invoking the callback, not after: the real
        // `readEntries` is asynchronous (the callback fires on a later tick),
        // but `readAllDirectoryEntries`'s callback recurses synchronously —
        // calling `cb` first and setting the flag after caused that
        // recursive call to run (and see `delivered` still false) before
        // this frame ever got to update it, i.e. genuine infinite recursion.
        readEntries: (cb) => {
          const batch = delivered ? [] : children;
          delivered = true;
          cb(batch);
        },
      }),
    };
  }

  /** A DataTransferItem-like object exposing only `getAsEntry` — no `webkitGetAsEntry` at all, matching the Firefox versions this bug was found on. */
  function itemWithOnlyLegacyGetAsEntry(entry: FakeEntry): DataTransferItem {
    return { getAsEntry: () => entry } as unknown as DataTransferItem;
  }

  function fakeItemList(items: DataTransferItem[]): DataTransferItemList {
    return Object.assign({ length: items.length }, items) as unknown as DataTransferItemList;
  }

  it("containsDirectory detects a folder via getAsEntry alone", () => {
    const items = fakeItemList([itemWithOnlyLegacyGetAsEntry(fakeDirEntry("/my-app", []))]);
    expect(containsDirectory(items)).toBe(true);
  });

  it("collectFilesFromDataTransferItems walks a folder via getAsEntry alone", async () => {
    const dockerfile = fakeFileEntry("/my-app/Dockerfile", "FROM node:20\n");
    const src = fakeFileEntry("/my-app/src/index.js", "x");
    const folder = fakeDirEntry("/my-app", [dockerfile, fakeDirEntry("/my-app/src", [src])]);
    const items = fakeItemList([itemWithOnlyLegacyGetAsEntry(folder)]);

    const collected = await collectFilesFromDataTransferItems(items);
    expect(collected.map((c) => c.relativePath).sort()).toEqual(["my-app/Dockerfile", "my-app/src/index.js"]);
  });
});
