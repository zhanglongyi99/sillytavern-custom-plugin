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

test('maps a selection across Markdown table cells and omits the delimiter row', () => {
    const raw = [
        '星野泉早期登场备注。',
        '',
        '| 回合 | 场景 | 核心事件 |',
        '| :---: | --- | --- |',
        '| 5 | 周二：公司茶水间 | 黄毛递来一杯红茶。 |',
        '| 6 | 周四：加班夜 | 两人在电梯口交谈。 |',
    ].join('\n');
    const selected = '回合\t场景\t核心事件\n5\t周二：公司茶水间\t黄毛递来一杯红茶。\n6\t周四：加班夜\t两人在电梯口交谈。';
    const projection = projectMarkdown(raw);
    const range = findSelectionRange(raw, selected, 12);

    assert.doesNotMatch(projection.text, /:---:/);
    assert.ok(range);
    assert.equal(range.rawText, [
        '回合 | 场景 | 核心事件 |',
        '| :---: | --- | --- |',
        '| 5 | 周二：公司茶水间 | 黄毛递来一杯红茶。 |',
        '| 6 | 周四：加班夜 | 两人在电梯口交谈。',
    ].join('\n'));
});

test('maps table selections when the browser concatenates adjacent cells', () => {
    const raw = [
        '| 回合 | 场景 | 核心事件 | 状态 |',
        '| --- | --- | --- | --- |',
        '| 10 | 第二周·连续三天 | 黄毛把她逼到高潮。 | 任务7 |',
        '| 11 | 第二周末·深夜办公室 | 她意识到自己回不去了。 | 任务8 |',
        '| 12 | 第三周·日常独处 | 她开始偷看手机。 | 任务9渐进 |',
    ].join('\n');
    const selected = [
        '10第二周·连续三天黄毛把她逼到高潮。任务7',
        '11第二周末·深夜办公室她意识到自己回不去了。任务8',
        '12第三周·日常独处她开始偷看手机。任务9渐进',
    ].join('');
    const range = findSelectionRange(raw, selected, 0);

    assert.ok(range);
    assert.equal(range.rawText, [
        '10 | 第二周·连续三天 | 黄毛把她逼到高潮。 | 任务7 |',
        '| 11 | 第二周末·深夜办公室 | 她意识到自己回不去了。 | 任务8 |',
        '| 12 | 第三周·日常独处 | 她开始偷看手机。 | 任务9渐进',
    ].join('\n'));
});

test('maps a selection that starts in prose and ends inside a table', () => {
    const raw = [
        '星野泉早期登场备注：这一面，要到很久以后才会被两人想起来。',
        '',
        '<details><summary>第一阶段·侵入（入职第一周~第四周）</summary>',
        '',
        '| 回合 | 场景 | 核心事件 | 完成任务 |',
        '| --- | --- | --- | --- |',
        '| 5 | 周二·公司茶水间 | 黄毛递来一杯英式红茶。 | 任务1、2 |',
        '| 6 | 周四·加班夜 | 两人在电梯口交谈。 | 任务3 |',
        '',
        '</details>',
    ].join('\n');
    const selected = [
        '这一面，要到很久以后才会被两人想起来。',
        '第一阶段·侵入（入职第一周~第四周）',
        '回合场景核心事件完成任务',
        '5周二·公司茶水间黄毛递来一杯英式红茶。任务1、2',
    ].join('');
    const range = findSelectionRange(raw, selected, 10);

    assert.ok(range);
    assert.match(range.rawText, /^这一面/);
    assert.match(range.rawText, /<details><summary>/);
    assert.match(range.rawText, /\| --- \| --- \| --- \| --- \|/);
    assert.match(range.rawText, /任务1、2$/);
    assert.doesNotMatch(range.rawText, /周四·加班夜/);
});

test('maps selections across raw HTML table cells', () => {
    const raw = '<table><tr><th>回合</th><th>场景</th></tr><tr><td>5</td><td>茶水间</td></tr></table>';
    const range = findSelectionRange(raw, '回合\t场景\n5\t茶水间', 0);

    assert.ok(range);
    assert.equal(range.rawText, '回合</th><th>场景</th></tr><tr><td>5</td><td>茶水间');
});

test('normalizes whitespace and typographic quotation marks for comparison', () => {
    assert.equal(normalizeComparable('  “别\n走”  '), '"别 走"');
});

test('preserves a single tilde while removing paired strikethrough markers', () => {
    assert.equal(projectMarkdown('第一周~第四周，~~旧计划~~').text, '第一周~第四周，旧计划');
});

test('rejects invalid replacement ranges', () => {
    assert.throws(() => replaceRange('abc', { start: 2, end: 4 }, 'x'), RangeError);
});
