import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { parseOrgConfig } from "../src/index.ts";

const raw = parse(readFileSync(new URL("../../../config/agentown.yaml", import.meta.url), "utf8"));

describe("runtime preset defaults", () => {
  it("fills nested defaults when workspace and resources are omitted", () => {
    const doc = structuredClone(raw);
    const preset = doc.runtimeCatalog[0];
    delete preset.workspace;
    delete preset.resources;
    delete preset.placement;
    const config = parseOrgConfig(stringify(doc));
    const parsed = config.runtimeCatalog.find((p) => p.id === preset.id)!;
    expect(parsed.workspace).toEqual({ size: "1Gi" });
    expect(parsed.resources).toEqual({ cpu: "500m", memory: "512Mi" });
    expect(parsed.placement).toBe("shared");
  });

  it("keeps values the owner set", () => {
    const config = parseOrgConfig(stringify(raw));
    const script = config.runtimeCatalog.find((p) => p.id === "script-v1")!;
    expect(script.workspace.size).toBe("256Mi");
    expect(script.resources).toEqual({ cpu: "250m", memory: "256Mi" });
  });
});
