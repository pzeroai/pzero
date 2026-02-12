import { describe, test, expect } from "bun:test";
import {
  getCachedQuery,
  setCachedQuery,
  getCachedLLM,
  setCachedLLM,
} from "../services/cache";

describe("cache", () => {
  describe("query cache", () => {
    test("returns undefined for cache miss", () => {
      expect(getCachedQuery("SELECT never_cached")).toBeUndefined();
    });

    test("stores and retrieves query results", () => {
      const data = [{ id: 1 }, { id: 2 }];
      setCachedQuery("SELECT cached_query", data);
      expect(getCachedQuery("SELECT cached_query")).toEqual(data);
    });

    test("same SQL returns same cached result", () => {
      const data = [{ x: 42 }];
      setCachedQuery("SELECT x FROM t", data);
      expect(getCachedQuery("SELECT x FROM t")).toBe(
        getCachedQuery("SELECT x FROM t")
      );
    });
  });

  describe("LLM cache", () => {
    test("returns undefined for cache miss", () => {
      expect(getCachedLLM("never_seen_key")).toBeUndefined();
    });

    test("stores and retrieves LLM results", () => {
      const result = { sql: "SELECT 1", chart: {}, explanation: "test" };
      setCachedLLM("llm_key_1", result);
      expect(getCachedLLM("llm_key_1")).toEqual(result);
    });
  });
});
