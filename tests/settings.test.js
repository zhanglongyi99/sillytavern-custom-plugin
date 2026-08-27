import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const settings = await readFile(new URL('../settings.html', import.meta.url), 'utf8');

test('declares the settings controls used by the runtime', () => {
    const ids = [
        'story_rewriter_enabled',
        'story_rewriter_context_mode',
        'story_rewriter_context_chars',
        'story_rewriter_response_length',
        'story_rewriter_full_response_length',
        'story_rewriter_retrieval_chars',
        'story_rewriter_retrieval_results',
        'story_rewriter_analysis_length',
        'story_rewriter_generation_timeout',
        'story_rewriter_persistent_undo',
    ];
    for (const id of ids) assert.match(settings, new RegExp(`id=["']${id}["']`));
});

test('keeps advanced settings visually grouped', () => {
    assert.match(settings, /<details[^>]*story-rewriter-advanced-settings/);
    assert.match(settings, /上下文降级策略/);
});
