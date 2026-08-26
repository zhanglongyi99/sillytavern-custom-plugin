import test from 'node:test';
import assert from 'node:assert/strict';

import {
    chooseVisibleSelectionRect,
    findSelectionRange,
    normalizeComparable,
    projectMarkdown,
    replaceRange,
} from '../lib/selection.js';

test('positions selection actions from the last visible line of a long selection', () => {
    const rects = [
        { top: -40, right: 200, bottom: -20, left: 20, width: 180, height: 20 },
        { top: 120, right: 300, bottom: 140, left: 20, width: 280, height: 20 },
        { top: 680, right: 260, bottom: 700, left: 20, width: 240, height: 20 },
        { top: 900, right: 280, bottom: 920, left: 20, width: 260, height: 20 },
    ];

    assert.equal(chooseVisibleSelectionRect(rects, 800, 720), rects[2]);
});

test('does not show selection actions when every selected line is outside the viewport', () => {
    const rects = [
        { top: -80, right: 200, bottom: -60, left: 20, width: 180, height: 20 },
        { top: 900, right: 260, bottom: 920, left: 20, width: 240, height: 20 },
    ];

    assert.equal(chooseVisibleSelectionRect(rects, 800, 720), null);
});

test('maps a plain Chinese selection to its raw range', () => {
    const raw = '她停了一下，然后说：“别走。”';
    const range = findSelectionRange(raw, '然后说：“别走。”', 6);

    assert.ok(range);
    assert.equal(range.rawText, '然后说：“别走。”');
    assert.equal(raw.slice(range.start, range.end), range.rawText);
});

test('keeps Markdown outside a selected emphasized phrase intact', () => {
    const raw = '她说：**别走。**然后转身。';
    const range = findSelectionRange(raw, '别走。', 3);

    assert.ok(range);
    assert.equal(range.rawText, '别走。');
    assert.equal(replaceRange(raw, range, '留下。'), '她说：**留下。**然后转身。');
});

test('includes Markdown markers that occur inside a multi-part selection', () => {
    const raw = '她*忽然*停下。';
    const range = findSelectionRange(raw, '她忽然停下', 0);

    assert.ok(range);
    assert.equal(range.rawText, '她*忽然*停下');
});

test('uses the visible selection offset to resolve duplicate passages', () => {
    const raw = '别走。她没有回答。别走。';
    const range = findSelectionRange(raw, '别走。', 10);

    assert.ok(range);
    assert.equal(range.start, raw.lastIndexOf('别走。'));
});

test('maps visible link text and omits the target URL', () => {
    const raw = '去[旧车站](https://example.com/station)等我。';
    const projection = projectMarkdown(raw);
    const range = findSelectionRange(raw, '旧车站', 1);

    assert.equal(projection.text, '去旧车站等我。');
    assert.ok(range);
    assert.equal(range.rawText, '旧车站');
});

test('normalizes whitespace and typographic quotation marks for comparison', () => {
    assert.equal(normalizeComparable('  “别\n走”  '), '"别 走"');
});

test('rejects invalid replacement ranges', () => {
    assert.throws(() => replaceRange('abc', { start: 2, end: 4 }, 'x'), RangeError);
});
