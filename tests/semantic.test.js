import test from 'node:test';
import assert from 'node:assert/strict';
import {
    auditRevision,
    buildImpactPrompt,
    buildRevisionPrompt,
    createChatChunks,
    estimateTokenCount,
    getFocusParagraphIds,
    parseRevisionResponse,
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
    const revisionPrompt = buildRevisionPrompt({
        ...base,
        impactPlan: { focusRegions: [{ paragraphId: 'P001' }], linkedRegions: [], transitionRegions: [], protectedFacts: [] },
    });
    assert.match(revisionPrompt, /"originalMessage": "贞德旧计划/);
    assert.match(revisionPrompt, /完整的新消息/);
});

test('parses a fenced structured full revision and rejects internal markers', () => {
    const parsed = parseRevisionResponse('```json\n{"revisedMessage":"完整文章","changeSummary":[]}\n```');
    assert.equal(parsed.revisedMessage, '完整文章');
    assert.throws(() => parseRevisionResponse({
        revisedMessage: '<story_rewriter_revision_contract>',
        changeSummary: [],
    }));
    assert.throws(() => parseRevisionResponse({
        revisedMessage: '<system-reminder>内部提示</system-reminder>正文',
        changeSummary: [],
    }));
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
