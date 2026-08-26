import test from 'node:test';
import assert from 'node:assert/strict';
import {
    assessRevisionCompleteness,
    auditRevision,
    buildImpactPrompt,
    buildRevisionContinuationPrompt,
    buildRevisionCoverageRepairPrompt,
    buildRevisionPrompt,
    buildChangedBlocks,
    compactSelectedText,
    composeRevisionFromDecisions,
    createChatChunks,
    estimateTokenCount,
    getFocusParagraphIds,
    IMPACT_JSON_SCHEMA,
    mergeRevisionContinuation,
    parseRevisionTextSegment,
    REVISION_END_MARKER,
    retrieveReferences,
    segmentMessage,
    validateImpactPlan,
} from '../lib/semantic.js';

test('segments Markdown blocks with stable raw offsets', () => {
    const raw = '# 标题\n\n第一段。\n仍是第一段。\n\n第二段。';
    const paragraphs = segmentMessage(raw);
    assert.deepEqual(paragraphs.map(item => item.id), ['P001', 'P002', 'P003']);
    assert.equal(raw.slice(paragraphs[1].start, paragraphs[1].end), '第一段。\n仍是第一段。');
});

test('maps a rough selection to every overlapping paragraph', () => {
    const raw = '甲段。\n\n乙段。\n\n丙段。';
    const paragraphs = segmentMessage(raw);
    const range = { start: raw.indexOf('甲段'), end: raw.indexOf('丙段') };
    assert.deepEqual(getFocusParagraphIds(paragraphs, range), ['P001', 'P002']);
    assert.deepEqual(getFocusParagraphIds(paragraphs, range, 'full'), ['P001', 'P002', 'P003']);
});

test('retrieves relevant character history while respecting source quotas', () => {
    const chunks = createChatChunks([
        { mes: '玛修留在基地。', name: 'AI' },
        { mes: '贞德在教堂留下了一封信。', name: 'AI' },
        { mes: '贞德的计划将在黎明开始。', name: 'AI' },
    ]);
    const result = retrieveReferences(chunks, '重新规划贞德线和教堂伏笔', {
        maxResults: 4,
        maxCharacters: 1000,
        quotas: { chat: 1 },
    });
    assert.equal(result.items.length, 1);
    assert.match(result.items[0].text, /贞德/);
});

test('estimates CJK text more conservatively than Latin text', () => {
    assert.ok(estimateTokenCount('这是十二个左右的中文字符') > estimateTokenCount('this is a similar length'));
});

test('compacts a long selection without losing its boundary cues', () => {
    const text = `开头${'中间'.repeat(2000)}结尾`;
    const compact = compactSelectedText(text, 200);
    assert.ok(compact.length <= 200);
    assert.match(compact, /^开头/);
    assert.match(compact, /结尾$/);
    assert.match(compact, /focusParagraphIds/);
});

test('does not retrieve authoritative but unrelated lore', () => {
    const result = retrieveReferences([
        { id: 'a', sourceType: 'world', text: '伦敦的固定地理设定。', keywords: ['伦敦'], authority: 'hard-lore' },
        { id: 'b', sourceType: 'world', text: '贞德位于教堂。', keywords: ['贞德'], authority: 'story-event' },
    ], '调整贞德线', { maxResults: 5, maxCharacters: 1000 });
    assert.deepEqual(result.items.map(item => item.id), ['b']);
});

test('truncates a single oversized matching source to the retrieval budget', () => {
    const result = retrieveReferences([
        { id: 'long', sourceType: 'world', text: `贞德${'设定'.repeat(1000)}`, keywords: ['贞德'], authority: 'hard-lore' },
    ], '贞德', { maxResults: 5, maxCharacters: 500 });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].truncated, true);
    assert.ok(result.characters <= 500);
});

test('drops invented impact regions and downgrades unsupported hard facts', () => {
    const paragraphs = segmentMessage('第一段。\n\n第二段包含贞德。');
    const plan = validateImpactPlan({
        objective: '调整贞德线',
        subjects: ['贞德'],
        linkedRegions: [
            { paragraphId: 'P002', quote: '贞德', reason: '直接相关', confidence: 0.9 },
            { paragraphId: 'P999', quote: '不存在', reason: '虚构', confidence: 1 },
        ],
        transitionRegions: [],
        protectedFacts: [{ fact: '玛修不变', sourceIds: ['missing'], strength: 'hard' }],
        missingInformation: [],
        additionalQueries: [],
        rewritePlan: ['调整'],
    }, paragraphs, ['P001'], []);
    assert.deepEqual(plan.focusRegions.map(item => item.paragraphId), ['P001']);
    assert.deepEqual(plan.linkedRegions.map(item => item.paragraphId), ['P002']);
    assert.equal(plan.protectedFacts[0].strength, 'soft');
});

test('accepts model-identified focus regions when the user did not select text', () => {
    const paragraphs = segmentMessage('贞德旧计划。\n\n玛修保持不变。');
    const plan = validateImpactPlan({
        objective: '调整贞德线',
        subjects: ['贞德'],
        focusRegions: [{ paragraphId: 'P001', selectedQuote: '贞德旧计划。', reason: '本轮直接目标' }],
        linkedRegions: [],
        transitionRegions: [],
        protectedFacts: [],
        missingInformation: [],
        additionalQueries: [],
        rewritePlan: ['调整第一段'],
    }, paragraphs, [], []);

    assert.deepEqual(plan.focusRegions.map(item => item.paragraphId), ['P001']);
});

test('builds source-grounded two-stage prompts without character offsets', () => {
    const paragraphs = segmentMessage('贞德旧计划。\n\n玛修保持不变。');
    const base = {
        editMode: 'semantic',
        influence: 'semantic',
        instruction: '重构贞德线',
        constraints: '玛修保持不变',
        originalMessage: '贞德旧计划。\n\n玛修保持不变。',
        selectedText: '贞德旧计划',
        paragraphs,
        focusIds: ['P001'],
        references: [{ id: 'rule', sourceType: 'instruction', authority: 'hard-rule', sourceLabel: '约束', text: '玛修保持不变' }],
    };
    const impactPrompt = buildImpactPrompt(base);
    assert.match(impactPrompt, /\[P001\] 贞德旧计划/);
    assert.doesNotMatch(impactPrompt, /"start"\s*:/);
    assert.match(impactPrompt, /不要复制原文引句/);
    assert.doesNotMatch(JSON.stringify(IMPACT_JSON_SCHEMA), /selectedQuote|"quote"/);
    const revisionPrompt = buildRevisionPrompt({
        ...base,
        impactPlan: { focusRegions: [{ paragraphId: 'P001' }], linkedRegions: [], transitionRegions: [], protectedFacts: [] },
    });
    assert.match(revisionPrompt, /"originalMessage": "贞德旧计划/);
    assert.match(revisionPrompt, /完整的新消息/);
    assert.match(revisionPrompt, /用户逐块筛选后的当前合成稿/);
    assert.match(revisionPrompt, new RegExp(REVISION_END_MARKER.replace(/[\[\]]/g, '\\$&')));
    assert.match(revisionPrompt, /不要输出.*JSON/);
});

test('parses terminal markers and detects an incomplete plain-text revision', () => {
    assert.deepEqual(
        parseRevisionTextSegment(`第一段。\n\n第二段。\n${REVISION_END_MARKER}`),
        { text: '第一段。\n\n第二段。', complete: true },
    );
    assert.deepEqual(
        parseRevisionTextSegment('尚未完成的正文'),
        { text: '尚未完成的正文', complete: false },
    );
    assert.deepEqual(
        parseRevisionTextSegment('\n\n续接段落保留边界\n\n'),
        { text: '\n\n续接段落保留边界\n\n', complete: false },
    );
    assert.deepEqual(
        parseRevisionTextSegment(`<think>内部推理</think>\n正文\n${REVISION_END_MARKER}`),
        { text: '正文', complete: true },
    );
    assert.deepEqual(
        parseRevisionTextSegment('<thinking>尚未结束的推理'),
        { text: '', complete: false },
    );
    assert.deepEqual(
        parseRevisionTextSegment(`<final>最终正文\n${REVISION_END_MARKER}</final>`),
        { text: '最终正文', complete: true },
    );
});

test('builds a continuation request and removes duplicated overlap', () => {
    const task = {
        instruction: '继续完成同一篇文章',
        constraints: '人物设定保持不变',
        originalMessage: '原文',
        impactPlan: { focusRegions: [], linkedRegions: [], transitionRegions: [], protectedFacts: [] },
        references: [{ id: 'lore', sourceType: 'world', authority: 'hard-lore', sourceLabel: '世界书', text: '固定设定' }],
    };
    const overlap = '这是用于自动续接去重的一段足够长的共同文本内容';
    const prompt = buildRevisionContinuationPrompt(task, `前缀${overlap}`);
    assert.match(prompt, /不要重写、总结、解释或重复已有前缀/);
    assert.match(prompt, new RegExp(overlap));
    assert.match(prompt, /固定设定/);
    assert.equal(
        mergeRevisionContinuation(`前缀${overlap}`, `${overlap}继续正文`),
        `前缀${overlap}继续正文`,
    );
});

test('rejects a short fragment that cannot cover protected paragraphs', () => {
    const original = [
        `重点段落：${'需要修改'.repeat(20)}`,
        `保护段落一：${'必须保留'.repeat(70)}`,
        `保护段落二：${'世界设定'.repeat(70)}`,
    ].join('\n\n');
    const plan = {
        focusRegions: [{ paragraphId: 'P001' }],
        linkedRegions: [],
        transitionRegions: [],
        protectedFacts: [],
    };
    const assessment = assessRevisionCompleteness(original, '这里只返回了修改后的重点片段。', plan);
    assert.equal(assessment.complete, false);
    assert.ok(assessment.minimumCharacters > assessment.candidateCharacters);
    const repairPrompt = buildRevisionCoverageRepairPrompt({
        editMode: 'semantic',
        influence: 'semantic',
        instruction: '修改重点',
        constraints: '',
        originalMessage: original,
        selectedText: '',
        focusIds: ['P001'],
        impactPlan: plan,
        references: [],
    }, assessment);
    assert.match(repairPrompt, /局部片段/);
    assert.match(repairPrompt, /保护区尽量逐字复制/);
});

test('only accepts a very short whole-message candidate when shortening was explicitly requested', () => {
    const original = `${'第一段全文重写。'.repeat(40)}\n\n${'第二段全文重写。'.repeat(40)}`;
    const plan = {
        focusRegions: [{ paragraphId: 'P001' }, { paragraphId: 'P002' }],
        linkedRegions: [],
        transitionRegions: [],
    };
    assert.equal(assessRevisionCompleteness(original, '过短的重构结果。', plan, '重新梳理人物线').complete, false);
    const assessment = assessRevisionCompleteness(original, '用户要求的精简全文。', plan, '把全文压缩成摘要');
    assert.equal(assessment.complete, true);
    assert.equal(assessment.shorteningRequested, true);
});

test('audits changes outside the planned region', () => {
    const original = '贞德原计划。\n\n玛修保持克制。\n\n其他内容不变。\n\n结尾不变。';
    const revised = '贞德采用新计划。\n\n玛修突然暴怒。\n\n其他内容彻底重写。\n\n结尾也改了。';
    const paragraphs = segmentMessage(original);
    const plan = {
        focusRegions: [{ paragraphId: paragraphs[0].id }],
        linkedRegions: [],
        transitionRegions: [],
        protectedFacts: [],
    };
    const audit = auditRevision(original, revised, plan, { editMode: 'semantic' });
    assert.equal(audit.counts.focus, 1);
    assert.equal(audit.counts.protected, 3);
    assert.equal(audit.hardBlocked, true);
});

test('composes a revision from independently accepted change blocks', () => {
    const original = '第一段不变。\n\n第二段旧文。\n\n第三段不变。';
    const revised = '第一段不变。\n\n第二段新文。\n\n新增段落。\n\n第三段不变。';
    const changes = buildChangedBlocks(segmentMessage(original), segmentMessage(revised));
    assert.deepEqual(changes.map(change => [change.id, change.kind]), [
        ['C001', 'modified'],
        ['C002', 'inserted'],
    ]);
    assert.equal(
        composeRevisionFromDecisions(original, revised, new Set(['C001'])),
        '第一段不变。\n\n第二段新文。\n\n第三段不变。',
    );
    assert.equal(
        composeRevisionFromDecisions(original, revised, new Set(['C002'])),
        '第一段不变。\n\n第二段旧文。\n\n新增段落。\n\n第三段不变。',
    );
});

test('keeps rewritten paragraphs aligned after a leading insertion', () => {
    const original = '贞德在教堂等待旧计划。\n\n玛修留在基地保持警戒。\n\n黄毛准备第二天的行动。';
    const revised = '新增的前情导语。\n\n贞德在教堂开始执行新计划。\n\n玛修仍在基地保持警戒。\n\n黄毛开始准备次日行动。';
    const changes = buildChangedBlocks(segmentMessage(original), segmentMessage(revised));
    assert.deepEqual(changes.map(change => [change.kind, change.originalId, change.anchorId]), [
        ['inserted', null, 'P001'],
        ['modified', 'P001', 'P001'],
        ['modified', 'P002', 'P002'],
        ['modified', 'P003', 'P003'],
    ]);
    assert.equal(
        composeRevisionFromDecisions(original, revised, new Set(['C002'])),
        '贞德在教堂开始执行新计划。\n\n玛修留在基地保持警戒。\n\n黄毛准备第二天的行动。',
    );
});

test('places a lone smart-rewrite fragment back onto its most similar source paragraph', () => {
    const original = '玛修留在基地等待命令。\n\n贞德在教堂执行旧计划并等待黄毛。\n\n凛奴负责外围调查。\n\n黄毛准备第二天的行动。';
    const fragment = '贞德改为在教堂主动协助黄毛执行新计划。';
    const changes = buildChangedBlocks(segmentMessage(original), segmentMessage(fragment));
    assert.deepEqual(changes.map(change => [change.kind, change.originalId]), [
        ['deleted', 'P001'],
        ['modified', 'P002'],
        ['deleted', 'P003'],
        ['deleted', 'P004'],
    ]);
    assert.equal(
        composeRevisionFromDecisions(original, fragment, new Set(['C002'])),
        '玛修留在基地等待命令。\n\n贞德改为在教堂主动协助黄毛执行新计划。\n\n凛奴负责外围调查。\n\n黄毛准备第二天的行动。',
    );
});

test('can accept or reject a proposed paragraph deletion', () => {
    const original = '保留开头。\n\n可能删除。\n\n保留结尾。';
    const revised = '保留开头。\n\n保留结尾。';
    const changes = buildChangedBlocks(segmentMessage(original), segmentMessage(revised));
    assert.deepEqual(changes.map(change => change.kind), ['deleted']);
    assert.equal(composeRevisionFromDecisions(original, revised, ['C001']), revised);
    assert.equal(composeRevisionFromDecisions(original, revised, []), original);
});

test('allows complete revision when the whole message is the focus', () => {
    const plan = {
        focusRegions: [{ paragraphId: 'P001' }, { paragraphId: 'P002' }],
        linkedRegions: [],
        transitionRegions: [],
        protectedFacts: [],
    };
    const audit = auditRevision('旧第一段。\n\n旧第二段。', '新第一段。\n\n新第二段。', plan, { editMode: 'full' });
    assert.equal(audit.counts.protected, 0);
    assert.equal(audit.hardBlocked, false);
});

test('does not exempt unselected whole-message edits from scope auditing', () => {
    const original = '第一段。\n\n第二段。\n\n第三段。\n\n第四段。';
    const revised = '重写一。\n\n重写二。\n\n重写三。\n\n重写四。';
    const plan = { focusRegions: [], linkedRegions: [], transitionRegions: [], protectedFacts: [] };
    const audit = auditRevision(original, revised, plan, { editMode: 'full' });
    assert.equal(audit.counts.protected, 4);
    assert.equal(audit.hardBlocked, true);
});

test('blocks deletion of a hard fact that is explicitly present in the original', () => {
    const original = '玛修的身份保持不变。\n\n贞德采用旧计划。';
    const revised = '玛修采用了新的身份。\n\n贞德采用新计划。';
    const plan = {
        focusRegions: [{ paragraphId: 'P002' }],
        linkedRegions: [],
        transitionRegions: [],
        protectedFacts: [{ fact: '玛修的身份保持不变', strength: 'hard', sourceIds: ['rule'] }],
    };
    const audit = auditRevision(original, revised, plan, { editMode: 'semantic' });
    assert.equal(audit.hardBlocked, true);
    assert.match(audit.conflicts.join('\n'), /硬保护/);
});
