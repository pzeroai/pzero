import { resolve, join } from "path";

// Resolve DATA_DIR the same way as apps/api — relative to source file, not cwd
export const DATA_DIR = resolve(
  process.env.DATA_DIR || join(import.meta.dir, "../../../../data"),
);
