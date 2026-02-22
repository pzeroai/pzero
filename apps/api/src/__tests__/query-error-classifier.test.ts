import { describe, expect, test } from "bun:test";
import { classifyQueryExecutionError } from "../lib/query-error-classifier";

describe("classifyQueryExecutionError", () => {
  test("classifies transport failures", () => {
    expect(classifyQueryExecutionError("The socket connection was closed unexpectedly")).toBe("transport");
  });

  test("classifies semantic SQL failures", () => {
    expect(classifyQueryExecutionError("Code: 47. DB::Exception: Unknown expression identifier `x` (UNKNOWN_IDENTIFIER)")).toBe("semantic_sql");
  });

  test("classifies unknown failures", () => {
    expect(classifyQueryExecutionError("some random failure")).toBe("unknown");
  });
});
