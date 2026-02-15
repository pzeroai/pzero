import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";

export function readCursor(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const val = readFileSync(path, "utf-8").trim();
    return val || null;
  } catch {
    return null;
  }
}

export function writeCursor(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, value, "utf-8");
  renameSync(tmpPath, path);
}

export function deleteCursor(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // ignore
  }
}
