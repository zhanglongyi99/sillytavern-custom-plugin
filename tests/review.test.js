import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReview, reviewPlan, buildReviewPrompt, buildReviewRepairInstruction } from '../lib/review.js';
import { buildRevisionPrompt, buildRevisionDeliveryRecoveryPrompt, buildRevisionContinuationPrompt } from '../lib/semantic.js';

const paragraphs = [{ id: 'P001', text: '人物还没有到达车站。' }];
const references = [{ id: 'history', text: '人物已经到达车站。' }];
const issue = { paragraphId: 'P001', problem: '时间冲突', fix: '核对到达时间', certainty: 'confirmed', evidenceId: 'history', evidenceQuote: '已经到达车站' };
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
