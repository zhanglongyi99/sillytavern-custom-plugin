import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const runtime = await readFile(new URL('../index.js', import.meta.url), 'utf8');

test('offers one selection action and two user-facing scope choices', () => {
    assert.match(runtime, /<span>修改<\/span>/);
    assert.match(runtime, />智能关联调整</);
    assert.match(runtime, />仅改选区</);
    assert.doesNotMatch(runtime, /<span>精确替换<\/span>|<span>柔性重构<\/span>/);
});

test('keeps technical context and influence selectors out of the workspace', () => {
    assert.doesNotMatch(runtime, /id="story-rewriter-session-context"/);
    assert.doesNotMatch(runtime, /id="story-rewriter-influence"/);
    assert.match(runtime, />应用为新版本</);
    assert.match(runtime, /修改这条回复/);
});

test('recovers a long auto-scrolled selection when pointer release is lost', () => {
    assert.match(runtime, /scheduleSelectionCapture\(180, true\)/);
    assert.match(runtime, /addEventListener\('mouseup', onSelectionPointerUp/);
    assert.match(runtime, /addEventListener\('touchend', onSelectionPointerUp/);
    assert.match(runtime, /addEventListener\('contextmenu', onSelectionPointerUp/);
});
