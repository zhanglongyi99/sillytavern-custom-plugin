import test from 'node:test';
import assert from 'node:assert/strict';
import {
    addDiagnosticRun,
    appendDiagnosticEvent,
    createDiagnosticArchive,
    exportDiagnosticArchive,
    finishDiagnosticRun,
    MAX_DIAGNOSTIC_RUNS,
    MAX_EVENTS_PER_RUN,
    normalizeDiagnosticArchive,
} from '../lib/diagnostics.js';

test('keeps only privacy-safe diagnostic fields and builds summaries', () => {
    let archive = addDiagnosticRun(createDiagnosticArchive(), {
        id: 'run-1',
        startedAt: '2026-08-28T00:00:00.000Z',
        extensionVersion: '0.6.3',
        editMode: 'semantic',
        prompt: 'secret prompt',
    });
    archive = appendDiagnosticEvent(archive, 'run-1', 'start', {
        stage: '初稿',
        responseLength: 4096,
        prompt: 'secret prompt',
        worldbook: 'secret lore',
        apiKey: 'secret key',
    }, '2026-08-28T00:00:01.000Z');
    archive = appendDiagnosticEvent(archive, 'run-1', 'parsed', {
        stage: '初稿',
        baseMode: 'original',
        disposition: 'failed_coverage',
        providerCharacters: 1200,
        usableCharacters: 900,
        parseOutcome: 'body_protocol',
        content: 'secret story',
    }, '2026-08-28T00:00:02.000Z');
    archive = appendDiagnosticEvent(archive, 'run-1', 'revision_effect', {
        baselineFingerprint: 'hash-a',
        candidateFingerprint: 'hash-b',
        equivalent: false,
        effectiveChange: true,
        similarity: 0.72,
        changedCharacters: 180,
        focusChanges: 2,
        plannedChanges: 3,
        protectedChanges: 0,
        retryAttempt: 1,
        retryReason: 'same draft',
        baselineText: 'secret baseline',
        candidateText: 'secret candidate',
    }, '2026-08-28T00:00:02.500Z');
    archive = finishDiagnosticRun(archive, 'run-1', 'completed', '2026-08-28T00:00:03.000Z');

    const serialized = JSON.stringify(exportDiagnosticArchive(archive, '2026-08-28T00:00:04.000Z'));
    assert.doesNotMatch(serialized, /secret|prompt"|worldbook|apiKey|content"/);
    assert.equal(archive.runs[0].summary.modelCalls, 1);
    assert.equal(archive.runs[0].summary.providerCharacters, 1200);
    assert.equal(archive.runs[0].summary.parseOutcomes.body_protocol, 1);
    assert.equal(archive.runs[0].events[1].baseMode, 'original');
    assert.equal(archive.runs[0].events[1].disposition, 'failed_coverage');
    assert.equal(archive.runs[0].events[2].baselineFingerprint, 'hash-a');
    assert.equal(archive.runs[0].events[2].focusChanges, 2);
    assert.equal(archive.runs[0].events[2].baselineText, undefined);
    assert.equal(archive.runs[0].status, 'completed');
});

test('caps runs and events at their newest entries', () => {
    let archive = createDiagnosticArchive();
    for (let index = 0; index < MAX_DIAGNOSTIC_RUNS + 4; index++) {
        archive = addDiagnosticRun(archive, {
            id: `run-${index}`,
            startedAt: new Date(index * 1000).toISOString(),
        });
    }
    assert.equal(archive.runs.length, MAX_DIAGNOSTIC_RUNS);
    assert.equal(archive.runs[0].id, 'run-4');

    const runId = archive.runs.at(-1).id;
    for (let index = 0; index < MAX_EVENTS_PER_RUN + 5; index++) {
        archive = appendDiagnosticEvent(archive, runId, 'parsed', {
            segment: index,
        }, new Date(index * 1000).toISOString());
    }
    const events = archive.runs.at(-1).events;
    assert.equal(events.length, MAX_EVENTS_PER_RUN);
    assert.equal(events[0].segment, 5);
});

test('recovers from malformed local data', () => {
    assert.deepEqual(normalizeDiagnosticArchive(null), createDiagnosticArchive());
    assert.deepEqual(normalizeDiagnosticArchive({ runs: [{ prompt: 'unsafe' }] }), createDiagnosticArchive());
});
