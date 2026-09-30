import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditRevision, assessRevisionEffect, createConservativeImpactPlan, segmentMessage,
    validateImpactPlan, constrainImpactPlan, composeRevisionFromDecisions } from '../lib/semantic.js';

const runtime = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const original = '第一段保持春天。\n\n第二段保持夏天。';
const candidate = '第一段改成秋天。\n\n第二段改成冬天。';
const fallback = () => createConservativeImpactPlan(segmentMessage(original), [], '只调整季节', 'full');

test('failed full analysis and legacy fallback snapshots cannot classify edits as planned', () => {
    for (const plan of [fallback(), { ...fallback(), fallbackReason: 'Error' }]) {
        const audit = auditRevision(original, candidate, plan);
        assert.ok(audit.changes.length);
        assert.ok(audit.changes.every(c => c.classification === 'unverified'));
        assert.equal(audit.counts.focus, 0);
        assert.equal(audit.counts.protected, 0);
        assert.equal(audit.counts.unverified, audit.changes.length);
        assert.match(audit.warnings.join(' '), /不能据此判断是否越界/);
        const effect = assessRevisionEffect(original, candidate, plan);
        assert.equal(effect.effective, true); // Retain the output without pretending it obeys scope.
        assert.equal(effect.plannedChanges, 0);
        assert.equal(effect.unverifiedChanges, audit.changes.length);
        assert.equal(assessRevisionEffect(original, original, plan).effective, false);
    }
});

test('normal successful analysis still distinguishes focus and protected changes', () => {
    const plan = { ...fallback(), fallback: false, focusRegions: [{ paragraphId: 'P001' }] };
    const audit = auditRevision(original, candidate, plan);
    assert.deepEqual(audit.changes.map(c => c.classification), ['focus', 'protected']);
    assert.equal(audit.counts.unverified, 0);
});

test('degraded insertions and deletions also need explicit confirmation', () => {
    for (const text of ['', `${original}\n\n新增结尾。`]) {
        const audit = auditRevision(original, text, fallback());
        assert.ok(audit.changes.every(c => c.classification === 'unverified'));
        assert.equal(composeRevisionFromDecisions(original, text, new Set(), audit.alignment), original);
        assert.equal(composeRevisionFromDecisions(original, text,
            new Set(audit.changes.map(c => c.id)), audit.alignment), text);
    }
});

test('default decisions keep unverified changes while explicit accept-all remains available', () => {
    const source = runtime.slice(runtime.indexOf('function initializeCandidateReview('), runtime.indexOf('function auditCurrentCandidate('));
    const audit = auditRevision(original, candidate, fallback());
    const state = { session: {} };
    const panel = { querySelector: () => ({ disabled: false }) };
    const initialize = new Function('state', 'createCandidateAudit', 'composeReviewCandidate', 'renderAudit',
        source + '; return initializeCandidateReview;')(state, () => audit,
        () => { state.session.candidate = original; }, () => {});
    initialize(panel, candidate);
    assert.equal(state.session.acceptedChangeIds.size, 0);
    assert.equal(state.session.proposalCandidate, candidate);
    initialize(panel, candidate, { acceptAll: true });
    assert.equal(state.session.acceptedChangeIds.size, audit.changes.length);
});

test('planned filter excludes unverified changes and dedicated filter displays them', () => {
    const source = runtime.slice(runtime.indexOf('function applyReviewFilter('), runtime.indexOf('function setReviewLayout('));
    const cards = ['focus', 'protected', 'unverified'].map(classification => ({ dataset: { classification } }));
    const state = { settings: {}, session: { reviewFilter: 'planned' } };
    const panel = { querySelectorAll: selector => selector.includes('[data-change-id]') ? cards : [] };
    const apply = new Function('state', source + '; return applyReviewFilter;')(state);
    apply(panel);
    assert.deepEqual(cards.map(c => c.hidden), [false, true, true]);
    state.session.reviewFilter = 'unverified'; apply(panel);
    assert.deepEqual(cards.map(c => c.hidden), [true, true, false]);
    state.session.reviewFilter = 'protected'; apply(panel);
    assert.deepEqual(cards.map(c => c.hidden), [true, false, true]);
    assert.match(runtime, /仅采用计划内[^\n]+classification !== 'unverified'/);
});

function refreshHarness(outcome, degraded = true) {
    const source = runtime.slice(runtime.indexOf('async function refreshRerollImpactPlan('), runtime.indexOf('async function rerollTurn('));
    const task = { paragraphs: segmentMessage(original), focusIds: [], references: [], influence: 'smart' };
    const plan = { ...fallback(), fallback: degraded };
    const session = { impactPlan: plan, activeLimits: { maxContext: 10000, maxResponse: 5000 } };
    const events = []; let calls = 0;
    const cancelled = new Error('cancelled');
    const refresh = new Function('state', 'getActiveGenerationLimits', 'setWorkspaceBusy', 'buildImpactPrompt',
        'countTokens', 'generateStructured', 'IMPACT_JSON_SCHEMA', 'parseImpactResponse', 'validateImpactPlan',
        'constrainImpactPlan', 'generationLog', 'isGenerationCancelled', 'renderImpactPlan',
        source + '; return refreshRerollImpactPlan;')(
        { settings: { analysisResponseLength: 4096 } }, async () => session.activeLimits, () => {}, () => 'same saved task',
        async () => 100, async () => {
            calls++;
            if (outcome === 'cancel') throw cancelled;
            if (outcome === 'error') throw new Error('upstream failure');
            return { objective: '修改季节', focusRegions: outcome === 'empty' ? [] : [{ paragraphId: 'P001' }] };
        }, {}, () => {}, validateImpactPlan, constrainImpactPlan,
        (event, metadata) => events.push({ event, ...metadata }), error => error === cancelled, () => {});
    return { session, events, run: () => refresh({}, session, { task, impactPlan: plan }), calls: () => calls };
}

test('reroll refreshes only failed scope analysis using the saved task', async () => {
    const healthy = refreshHarness('success', false); await healthy.run();
    assert.equal(healthy.calls(), 0);
    const recovered = refreshHarness('success'); await recovered.run();
    assert.equal(recovered.calls(), 1);
    assert.equal(recovered.session.impactPlan.fallback, false);
    assert.deepEqual(recovered.session.impactPlan.focusRegions.map(r => r.paragraphId), ['P001']);
    assert.equal(recovered.events[0].outcome, 'confirmed');
    for (const outcome of ['error', 'empty']) {
        const failed = refreshHarness(outcome); await failed.run();
        assert.equal(failed.session.impactPlan.fallback, true);
        assert.equal(failed.events[0].outcome, 'unverified');
    }
    const cancelled = refreshHarness('cancel');
    await assert.rejects(cancelled.run(), /cancelled/);
});

test('scope warning survives successful generation status and reroll invokes refresh', () => {
    assert.match(runtime, /const filteredNotice = \(session.reviewPlan.fallback/);
    assert.match(runtime, /if \(session.reviewPlan.fallback\) session.reviewFilter = 'all'/);
    assert.match(runtime, /await refreshRerollImpactPlan\(panel, session, request\);\s*await generateCompleteRevision/);
});
