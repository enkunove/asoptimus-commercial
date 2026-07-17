// Сборка самодостаточных бинарей (D6): `bun run build` → dist/.
// web-ui вшивается через `import … with { type: "text" }` (localserver.ts).
//
// Режимы:
//   bun run src/build.ts                 → dist/ все 4 таргета (прямая раздача бинаря)
//   bun run src/build.ts macos-arm64     → dist/ только один таргет (подстрока имени)
//   bun run src/build.ts --sidecar [dir] → macOS-бинари с ИМЕНЕМ ПОД TAURI-SIDECAR
//        (`<name>-<rust-triple>`), по умолчанию в desktop/src-tauri/binaries/.
//        Это то, что грузит десктоп-обёртка как bundle.externalBin.

import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), ".."); // client/

// Bun-таргет → (dist-имя, rust-triple для Tauri sidecar).
const TARGETS = [
  { bun: "bun-darwin-arm64", dist: "asoptimus-macos-arm64", triple: "aarch64-apple-darwin" },
  { bun: "bun-darwin-x64", dist: "asoptimus-macos-x64", triple: "x86_64-apple-darwin" },
  { bun: "bun-linux-x64", dist: "asoptimus-linux-x64", triple: "x86_64-unknown-linux-gnu" },
  { bun: "bun-windows-x64", dist: "asoptimus-windows-x64.exe", triple: "x86_64-pc-windows-msvc" },
] as const;

/** Базовое имя sidecar'а — должно совпадать с bundle.externalBin в tauri.conf.json. */
const SIDECAR_BASENAME = "asoptimus-sidecar";

function compile(outfile: string, bunTarget: string) {
  console.log(`→ ${outfile} (${bunTarget})`);
  const proc = Bun.spawnSync(
    ["bun", "build", "--compile", `--target=${bunTarget}`, "--outfile", outfile, join(root, "src", "main.ts")],
    { stdout: "inherit", stderr: "inherit", cwd: root },
  );
  if (proc.exitCode !== 0) {
    console.error(`Сборка ${outfile} не удалась`);
    process.exit(1);
  }
}

const argv = process.argv.slice(2);

if (argv[0] === "--sidecar") {
  // Только macOS-таргеты, имена под Tauri-sidecar (target-triple-suffixed).
  const outDir = argv[1] ?? join(root, "desktop", "src-tauri", "binaries");
  mkdirSync(outDir, { recursive: true });
  for (const t of TARGETS) {
    if (!t.bun.startsWith("bun-darwin-")) continue; // приложение — только macOS (BUILD-PLAN §9)
    compile(join(outDir, `${SIDECAR_BASENAME}-${t.triple}`), t.bun);
  }
  console.log(`Готово: sidecar-бинари в ${outDir}`);
} else {
  const only = argv[0]; // `bun run src/build.ts macos-arm64` — один таргет
  mkdirSync(join(root, "dist"), { recursive: true });
  for (const t of TARGETS) {
    if (only && !t.dist.includes(only)) continue;
    compile(join(root, "dist", t.dist), t.bun);
  }
  console.log("Готово: dist/");
}
