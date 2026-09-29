import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as protocol from '../lib/structured-response.js';
const runtime = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const source = runtime.slice(runtime.indexOf('async function generateStructured('), runtime.indexOf('function panelStatusForStructuredRetry('));

function harness(replies, limits = {}) {
    const calls = [];
    const state = { context: { generateQuietPrompt: async args => {
        calls.push(args);
        const result = replies.shift();
        if (result instanceof Error) throw result;
        return result;
    } } };
    const names = ['state', ...Object.keys(protocol), 'countTokens', 'runGenerationCall', 'isGenerationCancelled',
        'removeConfiguredReasoning', 'generationLog', 'hashText', 'panelStatusForStructuredRetry'];
    const generate = new Function(...names, source + '; return generateStructured;')(state, ...Object.values(protocol),
        async () => 1000, async (s, stage, fn) => fn(), () => false, x => x, () => {}, () => 'hash', () => {});
    return { calls, run: () => generate('whole chapter', { name: 'review' }, 4096, JSON.parse,
        { contextMode: 'tavern', activeLimits: limits }, '正文检查') };
}
test('incomplete then empty preserves schema, increases budget, and reports both failures', async () => {
    const h = harness(['{"objective":', '']);
    await assert.rejects(h.run(), /第 1 次：.*未完整闭合；第 2 次：.*未返回可用文本/);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0].responseLength, 4096);
    assert.equal(h.calls[1].responseLength, 8192);
    assert.equal(h.calls[1].jsonSchema.returnInvalid, true);
    assert.match(h.calls[1].quietPrompt, /最多 6 项/);
});
test('unsupported schema downgrades once, but network errors do not retry', async () => {
    const h = harness([new Error('json_schema is not supported'), '{"ok":true}']);
    assert.deepEqual(await h.run(), { ok: true });
    assert.equal(h.calls[1].jsonSchema, null);
    assert.equal(h.calls[1].responseLength, 4096);
    const network = harness([new Error('network timeout')]);
    await assert.rejects(network.run(), /network timeout/);
    assert.equal(network.calls.length, 1);
});
test('budget respects output/context limits and empty responses do not increase it', () => {
    const budget = protocol.structuredOutputBudget;
    assert.equal(budget(4096, 'incomplete_json', 1000, { maxResponse: 6000 }), 6000);
    assert.equal(budget(4096, 'incomplete_json', 1000, { maxContext: 5000 }), 3488);
    assert.equal(budget(4096, 'incomplete_json', 5000, { maxContext: 5000 }), 0);
    assert.equal(budget(4096, 'empty_response', 1000), 4096);
    assert.equal(protocol.isSchemaUnsupported(new Error('Unexpected end of JSON input')), false);
});
