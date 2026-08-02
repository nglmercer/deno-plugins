import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, cpSync, statSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";

// ============================================================================
// Build script for tray-app — compiles to a standalone Bun binary
// and verifies embedded/native files are properly bundled.
// Cross-platform: works on Linux, macOS, and Windows.
// ============================================================================

const ROOT = dirname(new URL(import.meta.url).pathname);
const OUTPUT_NAME = process.platform === "win32" ? "tray-app.exe" : "tray-app";
const BUILD_DIR = join(ROOT, "build");
const RELEASE_DIR = join(BUILD_DIR, "release");

// --- Platform detection ---
const PLATFORM = process.platform; // "linux" | "darwin" | "win32"
const ARCH = process.arch; // "x64" | "arm64"

// NAPI platform identifier used in .node filenames
function getNapiPlatform(): string {
  switch (PLATFORM) {
    case "linux":
      return `linux-${ARCH}-gnu`;
    case "darwin":
      return `darwin-${ARCH}`;
    case "win32":
      return `win32-${ARCH}-msvc`;
    default:
      return `${PLATFORM}-${ARCH}`;
  }
}

const NAPI_PLATFORM = getNapiPlatform();

console.log("========================================");
console.log("  Building tray-app");
console.log(`  Target: ${PLATFORM}-${ARCH}`);
console.log(`  NAPI platform: ${NAPI_PLATFORM}`);
console.log("========================================");

// --- Helpers ---
function run(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: PLATFORM === "win32" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function findMatchingNodeFile(pkgName: string, napiPlatform: string): string | null {
  const src = join(ROOT, "node_modules", pkgName);
  if (!existsSync(src)) return null;

  const files = readdirSync(src).filter((f) => f.endsWith(".node"));
  if (files.length === 0) return null;

  // Priority 1: exact match (e.g. linux-x64-gnu)
  for (const f of files) {
    if (f.includes(napiPlatform)) return join(src, f);
  }

  // Priority 2: os + arch without ABI suffix
  const osArch = `${PLATFORM}-${ARCH}`;
  for (const f of files) {
    if (f.includes(osArch)) return join(src, f);
  }

  // Priority 3: arch only (last resort)
  for (const f of files) {
    if (f.includes(ARCH)) return join(src, f);
  }

  return null;
}

let errors = 0;

// --- Step 1: Clean + Compile ---
console.log("\n[1/4] Compiling with Bun...");

rmSync(BUILD_DIR, { recursive: true, force: true });
mkdirSync(RELEASE_DIR, { recursive: true });

run("bun", [
  "build", "main.ts",
  "--compile",
  "--outfile", join(RELEASE_DIR, OUTPUT_NAME),
  "--target", `bun-${PLATFORM}-${ARCH}`,
  "--minify",
]);

const binaryPath = join(RELEASE_DIR, OUTPUT_NAME);
const binarySize = statSync(binaryPath).size;
console.log(`  Binary: ${binaryPath} (${formatSize(binarySize)})`);

// --- Step 2: Copy native .node addons ---
console.log("\n[2/4] Copying native .node addons...");

const napiPackages = ["napi-vm", "tray-icon-node", "webview-napi"];
const copiedNodeFiles: string[] = [];

for (const pkg of napiPackages) {
  const srcFile = findMatchingNodeFile(pkg, NAPI_PLATFORM);
  if (!srcFile) {
    console.log(`  WARNING: No matching .node for ${pkg} on ${NAPI_PLATFORM}`);
    const src = join(ROOT, "node_modules", pkg);
    if (existsSync(src)) {
      console.log("  Available files:");
      for (const f of readdirSync(src).filter((f) => f.endsWith(".node"))) {
        console.log(`    ${f}`);
      }
    }
    continue;
  }
  const dest = join(RELEASE_DIR, basename(srcFile));
  cpSync(srcFile, dest);
  copiedNodeFiles.push(basename(dest));
  console.log(`  Copied: ${basename(srcFile)} (${formatSize(statSync(dest).size)})`);
}



function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  [OK] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}`);
    errors++;
  }
}

check("Binary exists and is executable", existsSync(binaryPath));

for (const pkg of napiPackages) {
  const found = copiedNodeFiles.filter((f) => f.startsWith(pkg));
  check(`${pkg} .node file(s) found (${found.length})`, found.length > 0);
  for (const f of found) {
    console.log(`        ${f} (${formatSize(statSync(join(RELEASE_DIR, f)).size)})`);
  }
}

// --- Summary ---
console.log("\n========================================");
if (errors === 0) {
  console.log("  Build successful!");
  console.log(`  Output: ${RELEASE_DIR}/\n`);
  console.log("  Contents:");
  for (const entry of readdirSync(RELEASE_DIR, { withFileTypes: true })) {
    const full = join(RELEASE_DIR, entry.name);
    if (entry.isDirectory()) {
      console.log(`    📁 ${entry.name}/`);
    } else {
      console.log(`    📄 ${entry.name} (${formatSize(statSync(full).size)})`);
    }
  }
} else {
  console.log(`  Build completed with ${errors} error(s)`);
  process.exit(1);
}
console.log("========================================");
