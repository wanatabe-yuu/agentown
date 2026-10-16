import { z } from "zod";
import type { Actor } from "@agentown/core";
import type { Instance } from "../instance.ts";
import type { Service } from "../service.ts";
import type { ProviderTarget } from "../providers.ts";

export const chatConfigSchema = z.object({
  credentialId: z.string().min(1), model: z.string().min(1).max(120),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable().default("medium"),
  contextLimit: z.number().int().min(8192).max(1000000).default(64000),
  maxOutputTokens: z.number().int().min(256).max(32000).default(4096),
  maxTurns: z.number().int().min(1).max(40).default(5),
  approvalMode: z.enum(["important", "all"]).default("important"),
}).strict().refine(c => c.maxOutputTokens < c.contextLimit / 2, "output limit must be less than half the context budget");
export type ChatConfig = z.infer<typeof chatConfigSchema>;
export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface Message {
  role: "user" | "assistant" | "tool"; text: string;
  /** JPEG images (base64) shown with a user message: what a computer's camera sees. */
  images?: string[];
  calls?: ToolCall[]; toolId?: string; isError?: boolean;
  /** Provider blocks (including thinking/compaction signatures) never leave the server. */
  native?: unknown[]; reasoning?: string;
}
export interface Usage { inputTokens: number; outputTokens: number; cachedTokens: number; requests: number; compactions: number; incompleteRequests: number }
export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0, compactions: 0, incompleteRequests: 0 });
export interface ModelInfo { contextWindow: number | null; maxOutputTokens: number | null; nativeCompaction: boolean; efforts: string[] | null; adaptiveThinking?: boolean; contextSignature?: string }
export interface ToolContext { instance: Instance; service: Service; actor: Actor; idempotencyKey: string }
export interface ChatTool {
  name: string; description: string; schema: z.ZodType;
  mutates?: boolean; important?: boolean;
  execute: (ctx: ToolContext, args: any) => Promise<unknown>;
}
export interface ModelInput {
  system: string; messages: Message[]; tools: ChatTool[]; config: ChatConfig;
  info: ModelInfo; signal: AbortSignal; onText?: (text: string) => void;
}
export interface ChatModel {
  info(model: string, signal: AbortSignal): Promise<ModelInfo>;
  count(input: ModelInput): Promise<{ tokens: number; mode: "api" | "estimated" }>;
  complete(input: ModelInput): Promise<{ message: Message; usage: Usage; truncated?: boolean }>;
  compact(input: ModelInput): Promise<{ message: Message; usage: Usage }>;
}
export type ChatModelFactory = (target: ProviderTarget) => ChatModel;
