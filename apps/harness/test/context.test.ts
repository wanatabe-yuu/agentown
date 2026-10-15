import { describe, expect, it, vi } from 'vitest';
import { taskContext } from '../src/adapters/context.ts';
import type { RunContext } from '../src/adapters/types.ts';
const context = (limit: number | null = 8192) => ({ config: { contextLimit: limit }, event: vi.fn() }) as unknown as RunContext;
describe('task context budget', () => {
 it('compacts complete history with receipts while preserving the original request', async () => {
  const history=['Original owner request', `Saved model receipt: sonnet. Do not repeat. ${'x'.repeat(12000)}`];
  const summarize=vi.fn(async (text: string) => { expect(text).toContain('Saved model receipt'); return 'Verified saved model: sonnet; remaining work only.'; });
  const next=await taskContext(context(),history,{system:'Task'},summarize,summary=>[history[0]!,summary]);
  expect(summarize).toHaveBeenCalledTimes(1); expect(next[0]).toBe(history[0]); expect(next[1]).toContain('Verified saved model');
  expect(history).toHaveLength(2); expect(history[1]).toContain('x'.repeat(12000));
 });
 it('does not send an oversized original prompt to a summary request', async () => {
  const summarize=vi.fn(async()=> 'summary');
  await expect(taskContext(context(),['x'.repeat(30000)],{},summarize,s=>[s])).rejects.toThrow(/exceeds/);
  expect(summarize).not.toHaveBeenCalled();
 });
 it('preserves source history if compaction fails and leaves unconfigured runtimes unchanged', async()=>{
  const history=['Original request','x'.repeat(12000)]; const original=structuredClone(history);
  await expect(taskContext(context(),history,{},async()=>{throw new Error('Provider unavailable')},s=>[s])).rejects.toThrow('Provider unavailable');
  expect(history).toEqual(original);
  const summarize=vi.fn(async()=> 'summary');
  expect(await taskContext(context(null),history,{},summarize,s=>[s])).toBe(history); expect(summarize).not.toHaveBeenCalled();
 });
});
