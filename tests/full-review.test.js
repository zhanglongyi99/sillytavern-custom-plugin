import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildReviewDisplayRows, auditRevision } from '../lib/semantic.js';

test('full review interleaves unchanged beginning, middle and ending without changing decisions', () => {
    const original = '开头保留。\n\n春天的花园。\n\n中间保留。\n\n夏天的海边。\n\n结尾保留。';
    const candidate = original.replace('春天', '秋天').replace('夏天', '冬天');
    const review = auditRevision(original, candidate, { focusRegions: [], linkedRegions: [], transitionRegions: [], protectedFacts: [] });
    const changes = review.changes;
    const before = JSON.stringify(review);
    const rows = buildReviewDisplayRows(original, review);
    assert.deepEqual(rows.map(r => r.kind), ['unchanged', 'change', 'unchanged', 'change', 'unchanged']);
    assert.equal(rows[0].text, '开头保留。');
    assert.equal(rows.at(-1).text, '结尾保留。');
    assert.deepEqual(rows.filter(r => r.kind === 'change').map(r => r.change), changes);
    assert.equal(JSON.stringify(review), before);
});

test('unchanged runs merge and preserve literal markup', () => {
    const original = '<details>普通文本</details>\n\n第二段';
    const rows = buildReviewDisplayRows(original, { changes: [], alignment: [
        { kind: 'unchanged', originalIndices: [0] }, { kind: 'unchanged', originalIndices: [1] },
    ] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, original);
    assert.deepEqual(rows[0].originalIds, ['P001', 'P002']);
});

test('insertions and deletions keep their alignment order and existing change identities', () => {
    const changes = [{ id: 'C001', kind: 'inserted' }, { id: 'C002', kind: 'deleted' }];
    const rows = buildReviewDisplayRows('开头\n\n末尾', { changes, alignment: [
        { kind: 'inserted', originalIndices: [] },
        { kind: 'unchanged', originalIndices: [0] },
        { kind: 'deleted', originalIndices: [1] },
    ] });
    assert.equal(rows[0].change, changes[0]);
    assert.equal(rows[2].change, changes[1]);
});

test('full review visibility does not alter acceptance and follows all filter', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    const fn = source.slice(source.indexOf('function applyReviewFilter('), source.indexOf('function setReviewLayout('));
    const context = { hidden: true };
    const button = { setAttribute: (key, value) => { button[key] = value; } };
    const accepted = new Set(['C001']);
    const state = { settings: { showFullReview: true }, session: { reviewFilter: 'all', acceptedChangeIds: accepted } };
    const panel = { querySelectorAll: selector => selector === '.story-rewriter-unchanged-context' ? [context]
        : selector === '.story-rewriter-full-toggle' ? [button] : [] };
    const apply = new Function('state', fn + '; return applyReviewFilter;')(state);
    apply(panel);
    assert.equal(context.hidden, false);
    assert.equal(button['aria-pressed'], 'true');
    state.settings.showFullReview = false;
    apply(panel);
    assert.equal(context.hidden, true);
    assert.equal(state.session.acceptedChangeIds, accepted);
    assert.match(source, /content.textContent = row.text/);
});
