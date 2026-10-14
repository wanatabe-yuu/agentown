import { afterEach, expect, it, vi } from "vitest";
import { requestId } from "../src/requestId.ts";

afterEach(() => vi.unstubAllGlobals());

it("generates distinct UUIDs when an HTTP mobile browser has no randomUUID", () => {
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  vi.stubGlobal("crypto", { getRandomValues });
  const ids = Array.from({ length: 1000 }, () => requestId());
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every(id => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))).toBe(true);
});
