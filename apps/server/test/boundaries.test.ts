import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The layering in docs/ARCHITECTURE_V2.md: the World Kernel depends on nothing
// above it, and the kernel, Capability System and Proposal Engine never depend
// on where agents run, so the runtime (Kubernetes today) can be replaced.
const src = new URL("../src/", import.meta.url).pathname;
const imports = (file: string) =>
  [...readFileSync(join(src, file), "utf8").matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]!).filter((p) => p.startsWith("."));

describe("architecture boundaries", () => {
  it("the World Kernel imports only shared utilities, never the layers built on it", () => {
    for (const f of readdirSync(join(src, "kernel"))) {
      const bad = imports(`kernel/${f}`).filter((p) => !["../db.ts", "../util.ts", "../secrets.ts", "../providers.ts"].includes(p) && !p.startsWith("./"));
      expect(bad, `kernel/${f}`).toEqual([]);
    }
  });

  it("nothing but the runtime layer, its controller wiring and the model broker reaches into runtime/", () => {
    const runtimeFree = ["service.ts", "capabilities.ts", "proposals.ts", "conversations.ts", "owner-chat.ts", "instance.ts"];
    for (const f of runtimeFree) expect(imports(f).filter((p) => p.includes("runtime/")), f).toEqual([]);
    for (const f of readdirSync(join(src, "kernel"))) expect(imports(`kernel/${f}`).filter((p) => p.includes("runtime")), f).toEqual([]);
  });

  it("the Proposal Engine stands alone", () => {
    expect(imports("proposals.ts").filter((p) => !["./db.ts", "./util.ts"].includes(p))).toEqual([]);
  });
});
