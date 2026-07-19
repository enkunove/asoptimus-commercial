// Build of self-contained binaries (D6): `bun run build` → dist/.
// web-ui is embedded via `import … with { type: "text" }` (localserver.ts).
//
// Modes:
//   bun run src/build.ts                 → dist/ all 4 targets (direct binary distribution)
//   bun run src/build.ts macos-arm64     → dist/ single target only (name substring)
//   bun run src/build.ts --sidecar [dir] → macOS binaries NAMED FOR TAURI-SIDECAR
//        (`<name>-<rust-triple>`), by default into desktop/src-tauri/binaries/.
//        This is what the desktop wrapper loads as bundle.externalBin.

import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), ".."); // client/

// Bun target → (dist name, rust-triple for the Tauri sidecar).
const TARGETS = [
  { bun: "bun-darwin-arm64", dist: "asoptimus-macos-arm64", triple: "aarch64-apple-darwin" },
  { bun: "bun-darwin-x64", dist: "asoptimus-macos-x64", triple: "x86_64-apple-darwin" },
  { bun: "bun-linux-x64", dist: "asoptimus-linux-x64", triple: "x86_64-unknown-linux-gnu" },
  { bun: "bun-windows-x64", dist: "asoptimus-windows-x64.exe", triple: "x86_64-pc-windows-msvc" },
] as const;

/** Sidecar base name — must match bundle.externalBin in tauri.conf.json. */
const SIDECAR_BASENAME = "asoptimus-sidecar";

function compile(outfile: string, bunTarget: string) {
  console.log(`→ ${outfile} (${bunTarget})`);
  const proc = Bun.spawnSync(
    ["bun", "build", "--compile", `--target=${bunTarget}`, "--outfile", outfile, join(root, "src", "main.ts")],
    { stdout: "inherit", stderr: "inherit", cwd: root },
  );
  if (proc.exitCode !== 0) {
    console.error(`Build of ${outfile} failed`);
    process.exit(1);
  }
}

const argv = process.argv.slice(2);

if (argv[0] === "--sidecar") {
  // macOS targets only, names for Tauri sidecar (target-triple-suffixed).
  const outDir = argv[1] ?? join(root, "desktop", "src-tauri", "binaries");
  mkdirSync(outDir, { recursive: true });
  for (const t of TARGETS) {
    if (!t.bun.startsWith("bun-darwin-")) continue; // the app is macOS-only (BUILD-PLAN §9)
    compile(join(outDir, `${SIDECAR_BASENAME}-${t.triple}`), t.bun);
  }
  console.log(`Done: sidecar binaries in ${outDir}`);
} else {
  const only = argv[0]; // `bun run src/build.ts macos-arm64` — single target
  mkdirSync(join(root, "dist"), { recursive: true });
  for (const t of TARGETS) {
    if (only && !t.dist.includes(only)) continue;
    compile(join(root, "dist", t.dist), t.bun);
  }
  console.log("Done: dist/");
}
