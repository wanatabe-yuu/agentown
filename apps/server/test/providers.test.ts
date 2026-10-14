import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listModels, normalizeBaseUrl } from "../src/providers.ts";

/** GET /models against a local stand-in for an OpenAI-compatible provider. */
let server: http.Server;
let base: string;
const seen: Array<{ url: string; auth: string | undefined }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url === "/or/v1/key" && req.headers.authorization !== "Bearer sk-or-good") {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: "No auth credentials found" } }));
    }
    if (req.url === "/or/v1/key") return res.end(JSON.stringify({ data: { label: "k" } }));
    if (req.url === "/bad/v1/models") {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: { message: "Incorrect API key" } }));
    }
    if (req.url === "/array/v1/models") return res.end(JSON.stringify([{ id: "meta-llama/Llama-3.3-70B" }, { id: "BAAI/bge-embed-large" }]));
    if (req.url === "/gemini/v1/models") return res.end(JSON.stringify({ data: [{ id: "models/gemini-pro-x" }, { id: "models/text-embedding-004" }] }));
    res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-x" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }, { id: "gpt-x" }, { id: "a-chat" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

describe("listModels (OpenAI-compatible)", () => {
  it("lists chat models with the key as a bearer token", async () => {
    expect(await listModels({ provider: "openai", apiKey: "sk-1", workspaceId: null, baseUrl: `${base}/v1` })).toEqual(["a-chat", "gpt-x"]);
    expect(seen.at(-1)).toEqual({ url: "/v1/models", auth: "Bearer sk-1" });
  });

  it("accepts a bare array, sends no auth without a key, and normalizes Gemini ids", async () => {
    expect(await listModels({ provider: "custom", apiKey: "", workspaceId: null, baseUrl: `${base}/array/v1` })).toEqual(["meta-llama/Llama-3.3-70B"]);
    expect(seen.at(-1)!.auth).toBeUndefined();
    expect(await listModels({ provider: "gemini", apiKey: "k", workspaceId: null, baseUrl: `${base}/gemini/v1` })).toEqual(["gemini-pro-x"]);
  });

  it("surfaces the provider's rejection", async () => {
    await expect(listModels({ provider: "xai", apiKey: "k", workspaceId: null, baseUrl: `${base}/bad/v1` })).rejects.toThrow(/401.*Incorrect API key/);
  });

  it("checks an OpenRouter key on its key endpoint, since its model list is public", async () => {
    await expect(listModels({ provider: "openrouter", apiKey: "sk-or-bad", workspaceId: null, baseUrl: `${base}/or/v1` })).rejects.toThrow(/401/);
    expect(await listModels({ provider: "openrouter", apiKey: "sk-or-good", workspaceId: null, baseUrl: `${base}/or/v1` })).toEqual(["a-chat", "gpt-x"]);
  });
});

describe("normalizeBaseUrl", () => {
  it("keeps http(s) endpoints and strips trailing slashes", () => {
    expect(normalizeBaseUrl(" https://gw.example.com/openai/v1/ ")).toBe("https://gw.example.com/openai/v1");
    expect(normalizeBaseUrl("http://10.0.0.5:11434/v1")).toBe("http://10.0.0.5:11434/v1");
  });
  it("rejects other schemes, embedded credentials, queries and garbage", () => {
    for (const bad of ["ftp://h/v1", "file:///etc/passwd", "https://u:p@h/v1", "https://h/v1?key=1", "https://h/v1#x", "not a url"]) {
      expect(() => normalizeBaseUrl(bad)).toThrow();
    }
  });
});
