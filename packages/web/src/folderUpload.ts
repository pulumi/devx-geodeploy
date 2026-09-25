// Pure helpers for the wizard's "drag a whole project folder" drop path.
// Kept separate from Wizard.tsx so the traversal/filtering/encoding logic is
// unit-testable without a real DOM drag event or FileSystemEntry.

export interface CollectedFile {
  file: File;
  /** Forward-slash-separated path relative to the dropped folder's root, e.g. "src/index.js". */
  relativePath: string;
}

// A short, explicit ignore list — not a `.gitignore` parser — for the
// handful of huge/irrelevant directories a real project folder commonly
// contains. Without this, dropping a real project with `node_modules/`
// present would try to read and upload gigabytes of files.
const IGNORED_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", ".next", "venv", "__pycache__"]);
const IGNORED_FILE_NAMES = new Set([".DS_Store"]);

/** True when any path segment matches the ignore list. */
export function shouldIgnorePath(relativePath: string): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  return segments.some((segment, i) => {
    const isLast = i === segments.length - 1;
    return isLast ? IGNORED_FILE_NAMES.has(segment) : IGNORED_DIR_NAMES.has(segment);
  });
}

const DOCKERFILE_PATTERN = /(^|\/)Dockerfile(\.\w+)?$/i;

/** The shallowest (fewest path segments) Dockerfile-matching path among the given entries, or null if none match. */
export function findDockerfilePath(entries: readonly { relativePath: string }[]): string | null {
  const candidates = entries.map((e) => e.relativePath).filter((p) => DOCKERFILE_PATTERN.test(p));
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => a.split("/").length - b.split("/").length)[0]!;
}

/** Wraps `FileSystemDirectoryReader.readEntries()`, which pages results and must be called repeatedly until it returns an empty array. */
function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        readBatch();
      }, reject);
    };
    readBatch();
  });
}

function readEntryAsFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walkEntry(entry: FileSystemEntry, out: CollectedFile[]): Promise<void> {
  // fullPath always starts with "/" (the dropped item's own name is the
  // first segment) — stripped so relativePath reads like "src/index.js",
  // not "/my-folder/src/index.js".
  const relativePath = entry.fullPath.replace(/^\/+/, "");
  if (shouldIgnorePath(relativePath)) return;

  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children = await readAllDirectoryEntries(reader);
    for (const child of children) {
      await walkEntry(child, out);
    }
  } else if (entry.isFile) {
    const file = await readEntryAsFile(entry as FileSystemFileEntry);
    out.push({ file, relativePath });
  }
}

/**
 * `webkitGetAsEntry` is the de-facto name every engine ships, but support has
 * been inconsistent across Firefox versions — some only exposed the earlier,
 * unprefixed `getAsEntry` from the original File and Directory Entries API
 * draft. Confirmed live: a real folder drop in Firefox produced no entry at
 * all via `webkitGetAsEntry` alone, silently falling through to the
 * old single-file path (which then fails trying to `readAsText()` a
 * directory). Checking both names is the standard cross-browser shim.
 */
function getEntryFromItem(item: DataTransferItem): FileSystemEntry | null {
  const withLegacyEntry = item as DataTransferItem & { getAsEntry?: () => FileSystemEntry | null };
  return item.webkitGetAsEntry?.() ?? withLegacyEntry.getAsEntry?.() ?? null;
}

/** Drag-and-drop path: recursively walks every dropped item's filesystem entry, filtering out ignored paths as it goes. */
export async function collectFilesFromDataTransferItems(items: DataTransferItemList): Promise<CollectedFile[]> {
  const out: CollectedFile[] = [];
  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const entry = item && getEntryFromItem(item);
    if (entry) entries.push(entry);
  }
  for (const entry of entries) {
    await walkEntry(entry, out);
  }
  return out;
}

/** True when any of the dropped `DataTransferItem`s is a directory — the signal Wizard.tsx uses to branch into the folder-upload path instead of the existing single-Dockerfile path. */
export function containsDirectory(items: DataTransferItemList): boolean {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const entry = item && getEntryFromItem(item);
    if (entry?.isDirectory) return true;
  }
  return false;
}

/** `<input type=file webkitdirectory>` path: trivial wrapper around `File.webkitRelativePath`. Not wired into the UI yet (see Wizard.tsx's comment) — kept here, tested, for a straightforward future click-to-browse-a-folder addition. */
export function collectFilesFromFileList(fileList: FileList): CollectedFile[] {
  const out: CollectedFile[] = [];
  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    if (!file) continue;
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (shouldIgnorePath(relativePath)) continue;
    out.push({ file, relativePath });
  }
  return out;
}

/**
 * `File.arrayBuffer()` + `btoa` rather than `FileReader.readAsDataURL` —
 * both are available in every real browser this app targets AND in Node's
 * test environment (`FileReader` is browser-only, so a `FileReader`-based
 * version can't be unit-tested without a jsdom/happy-dom environment this
 * workspace doesn't otherwise need).
 */
async function readFileAsBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

export interface EncodedUploadFile {
  path: string;
  contentBase64: string;
}

/** Base64-encodes every file's raw bytes for the JSON-body upload to POST /api/build-context (see packages/cli/src/uiCmd.ts's handleBuildContextUpload). */
export async function encodeFilesForUpload(entries: readonly CollectedFile[]): Promise<EncodedUploadFile[]> {
  return Promise.all(
    entries.map(async (entry) => ({
      path: entry.relativePath,
      contentBase64: await readFileAsBase64(entry.file),
    })),
  );
}
