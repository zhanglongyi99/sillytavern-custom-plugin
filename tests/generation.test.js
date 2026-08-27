import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GenerationCancelledError,
    GenerationTimeoutError,
    runGuardedGeneration,
} from '../lib/generation.js';

test('times out a provider promise that never settles and asks the host to stop', async () => {
    let stopped = false;
    const events = [];
    await assert.rejects(
        runGuardedGeneration({
            operation: () => new Promise(() => {}),
            timeoutMs: 15,
            onTimeout: () => { stopped = true; },
            logger: event => events.push(event),
            metadata: { stage: '完整正文', segment: 2 },
        }),
        error => error instanceof GenerationTimeoutError && error.code === 'GENERATION_TIMEOUT',
    );
    assert.equal(stopped, true);
    assert.deepEqual(events, ['start', 'timeout']);
});

test('aborts plugin waiting without waiting for the provider promise', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = runGuardedGeneration({
        operation: () => new Promise(() => {}),
        timeoutMs: 1000,
        signal: controller.signal,
        metadata: { stage: '影响分析' },
    });
    controller.abort(new GenerationCancelledError());
    await assert.rejects(pending, error => error.code === 'GENERATION_CANCELLED');
    assert.ok(Date.now() - startedAt < 200);
});

test('returns successful provider output and records safe diagnostics', async () => {
    const records = [];
    const result = await runGuardedGeneration({
        operation: async () => 'candidate',
        timeoutMs: 100,
        logger: (event, metadata) => records.push({ event, metadata }),
        metadata: { stage: '局部替换', attempt: 1, responseLength: 1024 },
    });
    assert.equal(result, 'candidate');
    assert.equal(records[1].event, 'success');
    assert.equal(records[1].metadata.responseCharacters, 9);
    assert.equal('prompt' in records[1].metadata, false);
});
