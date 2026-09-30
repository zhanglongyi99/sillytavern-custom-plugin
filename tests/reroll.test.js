import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const runtime = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const source = runtime.slice(runtime.indexOf('async function rerollTurn('), runtime.indexOf('async function generateCandidate('));
function harness(outcome, kind = 'complete') {
    const turn = { candidate: 'bad second result', generationRequest: { kind, instruction: 'second request',
        task: { originalMessage: 'accepted first draft' }, baseline: 'accepted first draft', baseMode: 'current', impactPlan: {} } };
    const session = { turns: [turn], requirements: ['first', 'second'], candidate: 'current chosen draft',
        proposalCandidate: 'current proposal', acceptedChangeIds: new Set(['C001']), scopeMode: 'smart', capture: {} };
    const state = { session };
    const fields = { '.story-rewriter-instruction': { value: 'unsent third request' },
        '.story-rewriter-candidate': { value: session.candidate }, '.story-rewriter-status': { textContent: '' } };
    const panel = { isConnected: true, querySelector: key => fields[key] };
    let seen;
    const events = [];
    const generate = async (panel, request) => {
        seen = kind === 'complete' ? structuredClone(session.pendingTask) : structuredClone(request.task);
        if (outcome === 'failure') { session.candidate = 'partial'; session.generationBaseline = 'wrong'; return; }
        if (outcome === 'cancel') { session.cancelled = true; return; }
        if (outcome === 'error') throw new Error('test transport failure');
        if (outcome === 'low_coverage') { session.generationIncomplete = true; session.candidate = '31% partial'; return; }
        session.generationIncomplete = outcome === 'reviewable';
        session.candidate = 'rerolled draft'; session.turns.push({ candidate: session.candidate });
        session.requirements.push('duplicate'); fields['.story-rewriter-instruction'].value = '';
    };
    const reroll = new Function('state', 'cloneValue', 'captureIsCurrent', 'captureCandidateSnapshot', 'startGenerationSession',
        'generatePreciseCandidate', 'generateCompleteRevision', 'renderImpactPlan', 'renderAudit', 'renderSessionTurns', 'generationLog', 'finishGenerationDiagnostics', 'refreshRerollImpactPlan',
        source + '; return rerollTurn;')(state, structuredClone, () => true, () => {}, () => { session.generationInProgress = true; }, generate, generate, () => {}, () => {}, () => {},
        (event, metadata) => events.push({ event, ...metadata }), () => events.push({ event: 'finalized' }), async () => {
            if (outcome === 'scope_cancel') { session.cancelled = true; throw new Error('analysis cancelled'); }
        });
    return { session, fields, events, run: () => reroll(panel, turn, 1), seen: () => seen };
}
test('reroll reuses the saved input, preserves old candidate and unsent instruction', async () => {
    for (const kind of ['complete', 'precise']) {
        const h = harness('success', kind); await h.run();
        assert.equal(h.seen().originalMessage, 'accepted first draft');
        assert.equal(h.session.turns.length, 2);
        assert.equal(h.session.turns[0].candidate, 'bad second result');
        assert.equal(h.fields['.story-rewriter-instruction'].value, 'unsent third request');
        assert.deepEqual(h.session.requirements, ['first', 'second']);
        assert.equal(h.session.rerollRequest, null);
    }
});
test('failure and cancellation restore candidate and exact decisions', async () => {
    for (const outcome of ['failure', 'cancel', 'error', 'low_coverage', 'scope_cancel']) {
        const h = harness(outcome); await h.run();
        assert.equal(h.session.candidate, 'current chosen draft');
        assert.deepEqual([...h.session.acceptedChangeIds], ['C001']);
        assert.equal(h.session.turns.length, 1);
        assert.equal(h.fields['.story-rewriter-instruction'].value, 'unsent third request');
        assert.equal(h.events[0].disposition, 'restored_previous');
        assert.equal(h.session.generationInProgress, false);
    }
});
test('missing end marker retains admitted reroll for review without losing old candidate', async () => {
    const h = harness('reviewable'); await h.run();
    assert.equal(h.session.candidate, 'rerolled draft');
    assert.equal(h.session.generationIncomplete, true);
    assert.equal(h.session.turns.length, 2);
    assert.equal(h.session.turns[0].candidate, 'bad second result');
    assert.match(h.fields['.story-rewriter-status'].textContent, /请检查结尾.*未自动应用/);
    assert.equal(h.fields['.story-rewriter-instruction'].value, 'unsent third request');
    assert.equal(h.events[0].disposition, 'retained_for_review');
    assert.equal(h.events[0].sourceRound, 2);
    assert.equal(h.events.at(-1).event, 'finalized');
});

test('reroll diagnostics stay open until the outer retention decision', () => {
    const fnSource = runtime.slice(runtime.indexOf('function finishGenerationDiagnostics('), runtime.indexOf('function generationLog('));
    const calls = [];
    const finish = new Function('generationLog', 'finishDiagnosticRun', 'readDiagnosticStorage', 'diagnosticNow', 'writeDiagnosticStorage',
        fnSource + '; return finishGenerationDiagnostics;')(
        (...args) => calls.push(args), () => ({}), () => ({}), () => 'now', () => {});
    const session = { rerollLabel: 'round 2', diagnosticRunId: 'run' };
    finish(session, 'incomplete');
    assert.equal(session.diagnosticRunId, 'run');
    assert.equal(session.rerollDiagnosticStatus, 'incomplete');
    assert.equal(calls.length, 0);
    finish(session, session.rerollDiagnosticStatus, true);
    assert.equal(session.diagnosticRunId, null);
    assert.equal(calls[0][1].outcome, 'incomplete');
});
test('busy generation cannot start a concurrent reroll', async () => {
    const h = harness('success'); h.session.generationInProgress = true; await h.run();
    assert.equal(h.seen(), undefined);
});
