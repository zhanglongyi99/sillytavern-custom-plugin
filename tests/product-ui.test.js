import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const runtime = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');

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
    assert.match(runtime, /if \(state\.selectionPointerDown\) \{[\s\S]{0,240}scheduleSelectionSettleCapture\(\)/);
    assert.match(runtime, /scheduleSelectionCapture\(180\)/);
    assert.match(runtime, /function scheduleSelectionSettleCapture\(delay = 260\)/);
    assert.match(runtime, /if \(state\.selectionPointerDown\) \{\s*scheduleSelectionSettleCapture\(\)/);
    assert.match(runtime, /const liveSignature = getSelectionSignature\(\)/);
    assert.match(runtime, /addEventListener\('mouseup', onSelectionPointerUp/);
    assert.match(runtime, /addEventListener\('touchend', onSelectionPointerUp/);
    assert.match(runtime, /addEventListener\('contextmenu', onSelectionPointerUp/);
});

test('allows selecting a new target while an idle workspace is open', () => {
    assert.match(runtime, /state\.session\?\.generationInProgress/);
    assert.doesNotMatch(runtime, /state\.settings\.enabled \|\| state\.panel \|\| state\.selectionPointerDown/);
    assert.match(runtime, /const workspaceDraft = state\.panel/);
    assert.match(runtime, /const panelLeft = state\.panel\?\.getBoundingClientRect/);
    assert.match(styles, /\.story-rewriter-action\s*\{[\s\S]*?z-index: 10035/);
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
    assert.match(runtime, /settingsVersion: 8/);
    assert.match(runtime, /analysisResponseLength: 4096/);
    assert.match(runtime, /unterminated\|unexpected end\|end of json\|截断/);
    assert.match(runtime, /响应上限/);
    assert.match(runtime, /模型连续两次返回了不完整的影响分析数据/);
});

test('persists privacy-safe generation diagnostics without story content', () => {
    assert.match(runtime, /DIAGNOSTICS_STORAGE_KEY/);
    assert.match(runtime, /finishGenerationDiagnostics/);
    assert.match(runtime, /pluginPromptFingerprint/);
    assert.match(runtime, /retrieval_ready/);
    assert.match(runtime, /coverageRatio/);
    assert.match(runtime, /story-rewriter-diagnostics/);
});

test('continues long plain-text revisions instead of wrapping the article in JSON', () => {
    assert.match(runtime, /MAX_REVISION_SEGMENTS = 8/);
    assert.match(runtime, /fullResponseLength: 32768/);
    assert.match(runtime, /buildRevisionContinuationPrompt/);
    assert.match(runtime, /parseRevisionProviderResponse/);
    assert.match(runtime, /mergeRevisionContinuation/);
    assert.match(runtime, /未返回正文结束标记，正在请求/);
    assert.match(runtime, /removeReasoning: false/);
    assert.match(runtime, /parseReasoningFromString/);
    assert.doesNotMatch(runtime, /scripts\/reasoning\.js/);
    assert.match(runtime, /未找到明确正文，正在使用正文边界协议重试/);
    assert.match(runtime, /assessRevisionCompleteness/);
    assert.match(runtime, /正在进行完整性修复/);
    assert.match(runtime, /session\.generationIncomplete && change\.kind === 'deleted'/);
    assert.doesNotMatch(runtime, /generateStructured\([\s\S]{0,160}REVISION_JSON_SCHEMA/);
});

test('bounds every model call and preserves partial long-form output', () => {
    assert.match(runtime, /generationTimeoutSeconds: 180/);
    assert.match(runtime, /runGenerationCall\(session, '局部替换'/);
    assert.match(runtime, /runGenerationCall\(session, stageLabel/);
    assert.match(runtime, /runGenerationCall\(session, stage/);
    assert.match(runtime, /session\.partialCandidate/);
    assert.match(runtime, /isGenerationTimeout/);
    assert.match(runtime, /保留中断前收到的正文/);
    assert.doesNotMatch(runtime, /正文达到单次响应上限，正在自动续接/);
});

test('labels initial drafting and coverage repair as separate phases', () => {
    assert.match(runtime, /runRevision\(buildRevisionPrompt\(revisionTask\), '初稿'\)/);
    assert.match(runtime, /runRevision\(buildRevisionCoverageRepairPrompt\(revisionTask, coverage\), '完整性修复'\)/);
    assert.match(runtime, /当前显示的是已保留的/);
    assert.match(runtime, /parseOutcome/);
});

test('keeps Tavern context authoritative and degrades by capability', () => {
    assert.match(runtime, /session\.contextMode === 'local'/);
    assert.match(runtime, /getWorldInfoPrompt/);
    assert.doesNotMatch(runtime, /loadWorldInfo\?\./);
    assert.match(runtime, /jsonSchema: attempt === 0 \? schema : null/);
    assert.match(runtime, /createConservativeImpactPlan/);
    assert.doesNotMatch(runtime, /confidence >= 0\.85|confidence >= 0\.75/);
});

test('keeps final save authority with the user after audit warnings', () => {
    assert.match(runtime, /function confirmAuditRisks\(session, actionLabel\)/);
    assert.match(runtime, /审计仅提供风险提示，最终决定权属于你/);
    assert.doesNotMatch(runtime, /候选存在阻断项，不能保存|候选存在阻断项，不能替换/);
    assert.doesNotMatch(runtime, /apply\.disabled = !candidate\.value\.trim\(\) \|\|/);
});

test('separates independent tasks, valid turns, and quarantined failed attempts', () => {
    assert.match(runtime, />继续当前版本</);
    assert.match(runtime, />从原文开始新任务</);
    assert.match(runtime, /function recordFailedAttempt/);
    assert.match(runtime, /function captureCandidateSnapshot/);
    assert.match(runtime, /function restoreCandidateSnapshot/);
    assert.match(runtime, /本轮没有生成可用的新版本，当前有效候选保持不变/);
    assert.match(runtime, /实际候选摘要/);
    assert.match(runtime, /candidate: actualCandidate/);
    assert.match(runtime, /强制载入为可编辑草稿/);
    assert.match(runtime, /session\.forceLoadedAttemptId/);
    assert.match(styles, /\.story-rewriter-turn\.is-failed/);
});

test('treats each iteration as a real edit against its current baseline', () => {
    assert.match(runtime, /session\.generationBaseline = session\.pendingBaseMode === 'current'/);
    assert.match(runtime, /mapParagraphIdsToRevision/);
    assert.match(runtime, /assessRevisionEffect\(baseline, result\.assembled, effectivePlan\)/);
    assert.match(runtime, /buildRevisionNoChangeRetryPrompt/);
    assert.match(runtime, /模型连续两次没有执行本轮修改/);
    assert.match(runtime, /session\.reviewBaseline \|\| session\.capture\.messageText/);
    assert.match(runtime, /baselineFingerprint/);
});

test('supports block-level acceptance and a long-text review workspace', () => {
    assert.match(runtime, />逐块确认</);
    assert.match(runtime, /仅采用计划内/);
    assert.match(runtime, /全部采用/);
    assert.match(runtime, /全部保留原文/);
    assert.match(runtime, /change\.classification !== 'protected'/);
    assert.match(runtime, /composeRevisionFromDecisions/);
    assert.match(runtime, /story-rewriter-resize-handle/);
    assert.match(runtime, /story-rewriter-maximize/);
    assert.match(runtime, /保留原文/);
    assert.match(runtime, /采用新版/);
    assert.match(runtime, /上下对照/);
    assert.match(runtime, /疑似越界/);
    assert.match(runtime, /switchWorkspaceView\(panel, 'changes'\)/);
    assert.match(styles, /width: min\(960px, 98vw\)/);
    assert.match(styles, /\.story-rewriter-panel\.is-maximized/);
    assert.match(styles, /\.story-rewriter-panel:not\(\.is-selection-scope\) \.story-rewriter-candidate\s*\{[\s\S]*?min-height: 48vh/);
    assert.match(styles, /\.story-rewriter-diff-pair\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(styles, /\.story-rewriter-panel\.is-review-side \.story-rewriter-diff-pair\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
});
