import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const settings = await readFile(new URL('../settings.html', import.meta.url), 'utf8');

test('declares every v0.3 settings control used by the runtime', () => {
    const ids = [
        'story_rewriter_enabled',
        'story_rewriter_context_mode',
        'story_rewriter_context_chars',
        'story_rewriter_response_length',
        'story_rewriter_full_response_length',
        'story_rewriter_default_influence',
        'story_rewriter_confirm_impact',
        'story_rewriter_retrieval_chars',
        'story_rewriter_retrieval_results',
        'story_rewriter_analysis_length',
        'story_rewriter_persistent_undo',
    ];
    for (const id of ids) assert.match(settings, new RegExp(`id=["']${id}["']`));
});

test('offers all three semantic influence levels', () => {
    for (const value of ['strict', 'semantic', 'broad']) {
        assert.match(settings, new RegExp(`value=["']${value}["']`));
    }
});
