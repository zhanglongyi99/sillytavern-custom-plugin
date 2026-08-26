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

test('uses the active SillyTavern preset limits and tokenizer for budgeting', () => {
    assert.match(runtime, /getMaxContextTokens/);
    assert.match(runtime, /getMaxResponseTokens/);
    assert.match(runtime, /getTokenCountAsync/);
    assert.match(runtime, /当前预设/);
});

test('reads impact rendering state from the active session', () => {
    assert.match(runtime, /function renderImpactPlan\(panel\)\s*\{[\s\S]*?const session = state\.session;[\s\S]*?const plan = session\?\.impactPlan;/);
});

test('migrates the old impact-analysis budget to a non-truncating default', () => {
    assert.match(runtime, /settingsVersion: 5/);
    assert.match(runtime, /analysisResponseLength: 4096/);
    assert.match(runtime, /unterminated\|unexpected end\|end of json\|截断/);
    assert.match(runtime, /响应上限/);
    assert.match(runtime, /模型连续两次返回了不完整的影响分析数据/);
});

test('keeps final save authority with the user after audit warnings', () => {
    assert.match(runtime, /function confirmAuditRisks\(session, actionLabel\)/);
    assert.match(runtime, /审计仅提供风险提示，最终决定权属于你/);
    assert.doesNotMatch(runtime, /候选存在阻断项，不能保存|候选存在阻断项，不能替换/);
    assert.doesNotMatch(runtime, /apply\.disabled = !candidate\.value\.trim\(\) \|\|/);
});
