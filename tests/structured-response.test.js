import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStructuredResponse, structuredRetryHint, structuredFailureMessage, createHostJsonSchema, structuredOutputBudget, isSchemaUnsupported } from '../lib/structured-response.js';
import { parseImpactResponse } from '../lib/semantic.js';

const report = '{"objective":"检查","queries":[],"issues":[]}';
test('valid reports survive configured over-cleaning, fences and explicit reasoning', () => {
    for (const text of [report, '```json\n' + report + '\n```', '<think>private</think>' + report]) {
        let calls = 0;
        const result = parseStructuredResponse(text, parseImpactResponse, () => { calls++; return ''; });
        assert.equal(result.value.objective, '检查');
        assert.equal(calls, 0);
        assert.equal(result.metadata.parseOutcome, 'explicit_cleanup');
        assert.ok(!JSON.stringify(result).includes('private'));
    }
});
test('empty and reasoning-only responses are not valid empty reviews', () => {
    for (const [text, code] of [
        ['', 'empty_response'], ['  ', 'empty_response'],
        ['<think>' + report + '</think>', 'empty_after_cleanup'],
        ['<analysis>unfinished ' + report, 'empty_after_cleanup'],
        ['抱歉', 'non_json'], ['{"objective":"检查"', 'incomplete_json'],
        ['{}', 'empty_object'],
    ]) {
        const result = parseStructuredResponse(text, parseImpactResponse);
        assert.equal(result.value, null);
        assert.equal(result.metadata.errorCode, code);
        assert.ok(structuredFailureMessage(code));
    }
});

test('host JSON passthrough preserves malformed and fenced responses without mutating schema', () => {
    const schema = Object.freeze({ name: 'review', strict: true, value: {} });
    const passthrough = createHostJsonSchema(schema, 0);
    assert.equal(passthrough.returnInvalid, true);
    assert.equal(schema.returnInvalid, undefined);
    assert.equal(createHostJsonSchema(schema, 1, 'incomplete_json').returnInvalid, true);
    assert.equal(createHostJsonSchema(schema, 1, 'schema_unsupported'), null);
    const host = (text, options) => {
        try { return JSON.stringify(JSON.parse(text)); }
        catch { return options?.returnInvalid ? text : '{}'; }
    };
    const fenced = '```json\n' + report + '\n```';
    assert.equal(host(fenced, schema), '{}');
    assert.equal(parseStructuredResponse(host(fenced, passthrough), parseImpactResponse).value.objective, '检查');
    const broken = '{"objective":"unfinished';
    assert.equal(parseStructuredResponse(host(broken, passthrough), parseImpactResponse).metadata.errorCode, 'incomplete_json');
    assert.equal(host(report, passthrough), report);
    assert.equal(host('', passthrough), '');
    assert.equal(parseStructuredResponse(host('{}', passthrough), parseImpactResponse).metadata.errorCode, 'empty_object');
});
test('configured fallback is measured and does not expose removed text', () => {
    const result = parseStructuredResponse('custom wrapper', parseImpactResponse, () => report);
    assert.equal(result.value.objective, '检查');
    assert.equal(result.metadata.configuredCharacters, report.length);
    assert.equal(result.metadata.parseOutcome, 'configured_cleanup');
    const empty = parseStructuredResponse('custom wrapper', parseImpactResponse, () => '');
    assert.equal(empty.metadata.configuredCharacters, 0);
    assert.equal(empty.metadata.errorCode, 'empty_after_configured_cleanup');
    assert.equal(empty.value, null);
});
test('syntax classification respects quoted braces, escapes and malformed objects', () => {
    for (const text of ['{"objective":"brace } inside",', '{"objective":"escaped \\"', '{"objective": [']) {
        assert.equal(parseStructuredResponse(text, parseImpactResponse).metadata.errorCode, 'incomplete_json');
    }
    assert.equal(parseStructuredResponse('{"objective": nope}', parseImpactResponse).metadata.errorCode, 'invalid_json');
});
test('retry differentiates missing output and incomplete report while retaining citations', () => {
    assert.match(structuredRetryHint('empty_response'), /最终回答/);
    assert.match(structuredRetryHint('incomplete_json'), /必要证据/);
    assert.match(structuredRetryHint('invalid_report'), /字段和类型/);
});
