// Local pins & notes on keywords (spec 09 §7). CLIENT-SIDE ONLY: the user's private working
// state lives in <dataDir>/annotations/<runId>.json and is NEVER synced to the cloud
// (consistent with the local-first story). It survives run re-reads and dies with run deletion.
// The only time annotation content leaves this file is transiently inside an export render
// request (spec 09 §1/§7: pinned column in CSV, Shortlist in .md) — the server stores nothing.

import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { dataDir } from "./paths.ts";

export interface Annotation {
  pinned: boolean;
  note: string;
  updatedAt: string;
}
export type Annotations = Record<string, Annotation>;

const NOTE_MAX = 500;

function annotationsDir(): string {
  return join(dataDir(), "annotations");
}

function fileFor(runId: string): string {
  // runId comes from the cloud — sanitize before using it as a filename.
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(annotationsDir(), `${safe}.json`);
}

export function readAnnotations(runId: string): Annotations {
  try {
    const raw = readFileSync(fileFor(runId), "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Annotations;
  } catch { /* absent or unreadable → empty */ }
  return {};
}

export function writeAnnotation(
  runId: string,
  keyword: string,
  patch: { pinned?: boolean; note?: string },
): Annotations {
  const all = readAnnotations(runId);
  const prev = all[keyword] ?? { pinned: false, note: "", updatedAt: "" };
  const next: Annotation = {
    pinned: patch.pinned ?? prev.pinned,
    note: (patch.note ?? prev.note).slice(0, NOTE_MAX),
    updatedAt: new Date().toISOString(),
  };
  if (!next.pinned && !next.note.trim()) delete all[keyword]; // keep the file tidy
  else all[keyword] = next;
  mkdirSync(annotationsDir(), { recursive: true });
  writeFileSync(fileFor(runId), JSON.stringify(all, null, 2), "utf8");
  return all;
}

export function deleteAnnotations(runId: string): void {
  try {
    const f = fileFor(runId);
    if (existsSync(f)) unlinkSync(f);
  } catch { /* best effort — run deletion must not fail on this */ }
}

export function pinnedKeywords(runId: string): string[] {
  return Object.entries(readAnnotations(runId))
    .filter(([, a]) => a.pinned)
    .map(([k]) => k);
}

/** Non-empty notes only (for the export Shortlist render). */
export function notesMap(runId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, a] of Object.entries(readAnnotations(runId))) {
    if (a.note.trim()) out[k] = a.note;
  }
  return out;
}
