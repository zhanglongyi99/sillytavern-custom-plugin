import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReview, reviewPlan, buildReviewPrompt, buildReviewRepairInstruction, budgetReviewReferences, repairReviewReferences, assessReviewRepair } from '../lib/review.js';
import { buildRevisionPrompt, buildRevisionDeliveryRecoveryPrompt, buildRevisionContinuationPrompt } from '../lib/semantic.js';

const paragraphs = [{ id: 'P001', text: '人物还没有到达车站。' }];
const references = [{ id: 'history', text: '人物已经到达车站。' }];
const issue = { category: 'requirement', paragraphId: 'P001', problem: '时间冲突', fix: '核对到达时间', certainty: 'confirmed', evidenceId: 'history', evidenceQuote: '已经到达车站' };
test('continuity findings require two grounded locations and a known resolution', () => {
    const parts = [{ id: 'P001', text: '两人一同乘电梯上楼。' }, { id: 'P002', text: '同一时刻她独自乘电梯上楼。' }];
    const finding = { ...issue, category: 'continuity', evidenceId: 'P001', evidenceQuote: parts[0].text,
        counterpartId: 'P002', counterpartQuote: parts[1].text,
        alternativeExplanation: '两处均明确是同一时刻，不是先后两趟。', resolutionBasis: '以已确认的两人同行为准。', resolutionCertain: true };
    const parse = finding => parseReview(JSON.stringify({ objective: '检查', queries: [], issues: [finding] }), parts, []);
    assert.equal(parse(finding).issues[0].certainty, 'confirmed');
    for (const override of [{ counterpartId: 'missing' }, { counterpartQuote: '不存在的独行记录' },
        { counterpartId: 'P001', counterpartQuote: parts[0].text }, { resolutionCertain: false },
        { resolutionBasis: '' }, { alternativeExplanation: '' }, { category: undefined }]) {
        const report = parse({ ...finding, ...override });
        assert.equal(report.issues[0].certainty, 'uncertain');
        assert.equal(reviewPlan(report).focusRegions.length, 0);
    }
    assert.match(buildReviewRepairInstruction(parse(finding), parts), /同一时刻她独自乘电梯/);
    assert.deepEqual(reviewPlan(parse(finding)).linkedRegions, []); // Evidence alone is not permission to edit.
});
test('both external evidence sides survive repair handoff; style never auto-repairs', () => {
    const refs = [{ id: 'a', text: '书最后由甲保管。' }, { id: 'b', text: '同一时刻书仍在乙手里。' }];
    const findings = [{ ...issue, category: 'style', evidenceId: 'a', evidenceQuote: refs[0].text },
        { ...issue, category: 'continuity', evidenceId: 'a', evidenceQuote: refs[0].text,
            counterpartId: 'b', counterpartQuote: refs[1].text, alternativeExplanation: '无交接但同一时刻的归属明确冲突。',
            resolutionCertain: true, resolutionBasis: '以已确认的交接记录为准。' }];
    const report = parseReview(JSON.stringify({ objective: '核对', queries: [], issues: findings }), paragraphs, refs);
    assert.equal(report.issues[0].category, 'continuity');
    assert.equal(report.issues[1].certainty, 'suggestion');
    assert.deepEqual(repairReviewReferences(report, refs).map(item => item.id), ['a', 'b']);
});
test('review workflow prioritizes state and event checks with ambiguity safeguards', () => {
    const prompt = buildReviewPrompt({ paragraphs, references });
    for (const phrase of ['事件参与者', '相对日期', '物品从持有人', '信息何时由谁告诉谁',
        '缺少交接描写不等于已证实矛盾', '隐藏真相不等于视角人物知情', '不能擅自选正文或日志为真']) {
        assert.ok(prompt.includes(phrase));
    }
    assert.ok(prompt.indexOf('本章硬一致性 continuity') < prompt.indexOf('可选风格 style'));
});
test('history budget deduplicates and strips metadata without truncating the chapter', () => {
    const items = budgetReviewReferences([
        { id: 'a', text: '甲乙丙', keywords: ['internal'], previousId: 'secret' },
        { id: 'b', text: '甲乙丙' }, { id: 'a', text: '不同内容' },
        { id: 'c', text: '太长的资料不会截成假完整资料' }, { id: 'd', text: '丁戊' },
    ], 5, 3);
    assert.deepEqual(items.map(x => x.id), ['a', 'd']);
    assert.equal(items[0].keywords, undefined);
    assert.deepEqual(budgetReviewReferences(references, 0), []);
    assert.equal(budgetReviewReferences(references, 100, 0).length, 0);
    const chapter = '完整本章'.repeat(10000);
    const prompt = buildReviewPrompt({ paragraphs: [{ id: 'P001', text: chapter }], references: items });
    assert.ok(prompt.includes(chapter));
    assert.doesNotMatch(prompt, /internal|secret/);
});
test('repair keeps only confirmed citations and preserves distant quoted evidence', () => {
    const ref = { id: 'large', text: '甲'.repeat(2000) + '证据一' + '乙'.repeat(2000) + '证据二' + '丙'.repeat(2000) };
    const report = { issues: [
        { ...issue, evidenceId: 'large', evidenceQuote: '证据一' },
        { ...issue, evidenceId: 'large', evidenceQuote: '证据二' },
        { ...issue, certainty: 'uncertain' },
    ] };
    const refs = repairReviewReferences(report, [ref, ...references]);
    assert.equal(refs.length, 1);
    assert.ok(refs[0].text.length < 1700);
    assert.ok(refs[0].text.includes('证据一') && refs[0].text.includes('证据二'));
});
test('repair checks every issue and linked target, not just any focus change', () => {
    const baseline = '人物还没有到达车站。\n\n日志记录时间是晚上。\n\n保持这段不变。';
    const report = { issues: [{ ...issue, relatedParagraphIds: ['P002'] }] };
    const result = assessReviewRepair(report, baseline, baseline.replace('还没有', '已经'), reviewPlan(report));
    assert.equal(result.pendingIssues, 1);
    assert.deepEqual(result.issues[0].missing, ['P002']);
    assert.match(result.message, /不代表问题已解决/);
    const complete = assessReviewRepair(report, baseline, baseline.replace('还没有', '已经').replace('晚上', '清晨'), reviewPlan(report));
    assert.equal(complete.pendingIssues, 0);
    const unchanged = assessReviewRepair(report, baseline, baseline, reviewPlan(report));
    assert.deepEqual(unchanged.issues[0].missing, ['P001', 'P002']);
});
test('whole chapter review grounds global advice and maps IDs across every repair protocol', () => {
    const parts = [...paragraphs, { id: 'P002', text: '日志记录了另外的时间。' }];
    const report = parseReview(JSON.stringify({ objective: '检查', queries: [], issues: [
        { ...issue, globalRevision: '统一正文与日志的到达时间。', relatedParagraphIds: ['P002', 'P999'] },
        { ...issue, certainty: 'uncertain', globalRevision: '无证据意见不得进入修订。' },
    ] }), parts, references);
    const plan = reviewPlan(report);
    assert.deepEqual(plan.linkedRegions.map(p => p.paragraphId), ['P002']);
    const instruction = buildReviewRepairInstruction(report, parts);
    assert.match(instruction, /统一正文与日志/);
    assert.match(instruction, /人物还没有到达车站/);
    assert.doesNotMatch(instruction, /无证据意见不得进入修订/);
    const prompt = buildReviewPrompt({ paragraphs: parts, references });
    assert.match(prompt, /通读 chapterText 整章/);
    assert.ok(prompt.includes('日志记录了另外的时间'));
    const task = { instruction, originalMessage: parts.map(p => p.text).join('\n\n'), impactPlan: plan, references, focusIds: ['P001'] };
    for (const result of [buildRevisionPrompt(task), buildRevisionDeliveryRecoveryPrompt(task), buildRevisionContinuationPrompt(task, '已生成前缀')]) {
        assert.match(result, /paragraphIndex/);
        assert.match(result, /日志记录了另外的时间/);
        assert.match(result, /"id"\s*:\s*"P002"/);
    }
});
test('review only promotes grounded issues at valid locations into repair plan', () => {
    const raw = JSON.stringify({ objective: '检查', queries: [], issues: [issue,
        { ...issue, evidenceId: 'invented' }, { ...issue, evidenceQuote: '不存在的证据' },
        { ...issue, paragraphId: 'P999' }, { ...issue, certainty: 'suggestion' },
    ] });
    const report = parseReview(raw, paragraphs, references);
    assert.deepEqual(report.issues.map(i => i.certainty), ['confirmed', 'uncertain', 'uncertain', 'uncertain', 'suggestion']);
    assert.equal(reviewPlan(report).rewritePlan.length, 1);
    assert.deepEqual(reviewPlan(report).focusRegions.map(p => p.paragraphId), ['P001']);
});
test('review bounds queries and does not invent repairs for an empty report', () => {
    const report = parseReview(JSON.stringify({ objective: '无问题', queries: ['a', 'b', 'c', 'd'], issues: [] }), paragraphs, references);
    assert.equal(report.queries.length, 3);
    assert.equal(reviewPlan(report).focusRegions.length, 0);
    assert.throws(() => parseReview('{"objective":"bad"}', paragraphs, references));
    assert.match(buildReviewPrompt({ paragraphs, references }, report), /唯一一次补查/);
});
