import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { revisionBudget } from '../lib/revision-budget.js';
import { addDiagnosticRun, appendDiagnosticEvent } from '../lib/diagnostics.js';

test('8570-token first response does not exhaust the configured 32768-token text allowance', () => {
    const base = { estimatedOutput: 8570, totalLimit: 32768, responseLimit: 100000 };
    assert.equal(revisionBudget(base).request, 8570);
    const next = revisionBudget({ ...base, usedTokens: 8600 });
    assert.equal(next.request, 8570);
    assert.equal(next.remaining, 24168);
    assert.equal(next.stopReason, '');
});
test('respects total, context and per-request caps independently', () => {
    const base = { estimatedOutput: 8570, totalLimit: 32768, usedTokens: 32000 };
    assert.equal(revisionBudget(base).request, 768);
    assert.equal(revisionBudget({ ...base, usedTokens: 32700 }).stopReason, 'budget_exhausted');
    assert.equal(revisionBudget({ ...base, contextAvailable: 100 }).stopReason, 'context_exhausted');
    assert.equal(revisionBudget({ ...base, responseLimit: 128 }).stopReason, 'response_limit');
    assert.equal(revisionBudget({ ...base, responseLimit: 512 }).request, 512);
    assert.equal(revisionBudget({ ...base, usedTokens: 40000 }).request, 0);
});
test('runtime separates estimate from cumulative allowance and archives budget diagnostics', async () => {
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.match(source, /let remainingBudget = totalRevisionLimit/);
    assert.doesNotMatch(source, /desiredResponseLength - usedTokens/);
    const archive = addDiagnosticRun({}, { id: 'budget', startedAt: 'now' });
    const result = appendDiagnosticEvent(archive, 'budget', 'revision_budget', {
        estimatedOutput: 8570, totalLimit: 32768, usedTokens: 8600, remainingTokens: 24168,
    }, 'later');
    assert.equal(result.runs[0].events[0].remainingTokens, 24168);
});
