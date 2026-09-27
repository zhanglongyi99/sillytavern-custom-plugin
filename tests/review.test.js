import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReview, reviewPlan, buildReviewPrompt } from '../lib/review.js';

const paragraphs = [{ id: 'P001', text: '人物还没有到达车站。' }];
const references = [{ id: 'history', text: '人物已经到达车站。' }];
const issue = { paragraphId: 'P001', problem: '时间冲突', fix: '核对到达时间', certainty: 'confirmed', evidenceId: 'history', evidenceQuote: '已经到达车站' };
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
