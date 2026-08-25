import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildFullContextRewritePrompt,
    buildRewritePrompt,
    cleanModelResponse,
    createRewriteTask,
} from '../lib/rewrite.js';

test('builds a rewrite task with bounded surrounding context', () => {
    const task = createRewriteTask('0123456789', { start: 4, end: 6 }, '更紧张', 3);

    assert.deepEqual(task, {
        before: '123',
        selection: '45',
        after: '678',
        instruction: '更紧张',
    });
});

test('serializes story data and instruction into the prompt', () => {
    const prompt = buildRewritePrompt({
        before: '前文',
        selection: '原文',
        after: '后文',
        instruction: '更克制',
    });

    assert.match(prompt, /"selection": "原文"/);
    assert.match(prompt, /"instruction": "更克制"/);
    assert.match(prompt, /只输出可以直接替换 target\.selection 的文字/);
});

test('includes prior requirements and a previous candidate for iterative editing', () => {
    const prompt = buildFullContextRewritePrompt({
        before: '前文',
        selection: '原文',
        after: '后文',
        instruction: '再克制一点',
        constraints: '不要改变事件',
        previousCandidate: '第一版候选',
        previousInstructions: ['增加紧张感'],
    });

    assert.match(prompt, /story_rewriter_contract/);
    assert.match(prompt, /SillyTavern 已在本次请求中提供当前角色/);
    assert.match(prompt, /"request"/);
    assert.match(prompt, /"previousDraft": "第一版候选"/);
    assert.match(prompt, /不要改变事件/);
    assert.match(prompt, /第一版候选/);
    assert.match(prompt, /增加紧张感/);
});

test('strips a single enclosing Markdown code fence', () => {
    assert.equal(cleanModelResponse('```text\n改写结果\n```'), '改写结果');
});

test('preserves ordinary Markdown returned by the model', () => {
    assert.equal(cleanModelResponse('  **改写结果**  '), '**改写结果**');
});
