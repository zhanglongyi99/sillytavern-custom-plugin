import test from 'node:test';
import assert from 'node:assert/strict';
import { diffInline } from '../lib/inline-diff.js';

test('isolates punctuation replacements and preserves source strings', () => {
    const diff = diffInline('她先低头，“晚安。”', '她先低头。“晚安。”');
    assert.equal(diff.original.filter(p => p.changed).map(p => p.text).join(''), '，');
    assert.equal(diff.candidate.filter(p => p.changed).map(p => p.text).join(''), '。');
});

test('handles insertions, deletions, Unicode, whitespace and bounded fallback losslessly', () => {
    for (const [a, b] of [['', '新增'], ['删除', ''], ['😀一二三', '😀一四三'], ['a b\n', 'ab\n'], ['<b>原文</b>', '<b>新版</b>'], ['abc', 'abc']]) {
        for (const budget of [1, 1000000]) {
            const diff = diffInline(a, b, budget);
            assert.equal(diff.original.map(p => p.text).join(''), a);
            assert.equal(diff.candidate.map(p => p.text).join(''), b);
        }
    }
});
