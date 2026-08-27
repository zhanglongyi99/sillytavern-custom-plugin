import { chooseVisibleSelectionRect, findSelectionRange, replaceRange } from './lib/selection.js';
import {
    DEFAULT_SYSTEM_PROMPT,
    buildFullContextRewritePrompt,
    buildRewritePrompt,
    cleanModelResponse,
    createRewriteTask,
    REPLACEMENT_JSON_SCHEMA,
} from './lib/rewrite.js';
import {
    assessRevisionCompleteness,
    auditRevision,
    buildImpactPrompt,
    buildRevisionContinuationPrompt,
    buildRevisionCoverageRepairPrompt,
    buildRevisionPrompt,
    compactSelectedText,
    composeRevisionFromDecisions,
    constrainImpactPlan,
    createActivatedWorldInfoChunks,
    createCharacterChunks,
    createChatChunks,
    createConservativeImpactPlan,
    estimateTokenCount,
    getFocusParagraphIds,
    IMPACT_JSON_SCHEMA,
    IMPACT_LEVELS,
    mergeRevisionContinuation,
    parseImpactResponse,
    parseRevisionTextSegment,
    retrieveReferences,
    segmentMessage,
    validateImpactPlan,
} from './lib/semantic.js';
import { appendRevisionSwipe } from './lib/swipe.js';
import {
    GenerationCancelledError,
    isGenerationCancelled,
    isGenerationTimeout,
    runGuardedGeneration,
} from './lib/generation.js';

const EXTENSION_KEY = 'story_rewriter';
const HISTORY_KEY = 'story_rewriter_history';
const MAX_HISTORY = 5;
const MAX_SESSION_TURNS = 8;
const MAX_REVISION_SEGMENTS = 8;
const CONTEXT_MODES = new Set(['tavern', 'local']);
const EDIT_MODES = new Set(['semantic', 'full']);
const SCOPE_MODES = new Set(['selection', 'smart']);
const DEFAULT_SETTINGS = Object.freeze({
    settingsVersion: 7,
    enabled: true,
    contextMode: 'tavern',
    contextCharacters: 2000,
    responseLength: 1024,
    fullResponseLength: 32768,
    persistentUndo: true,
    defaultInfluence: 'semantic',
    confirmImpact: false,
    retrievalCharacters: 12000,
    retrievalResults: 18,
    analysisResponseLength: 4096,
    generationTimeoutSeconds: 180,
});

const state = {
    active: false,
    context: null,
    settings: null,
    capture: null,
    actionButton: null,
    panel: null,
    session: null,
    snackbar: null,
    observer: null,
    observerQueued: false,
    selectionCaptureTimer: null,
    selectionPointerDown: false,
    panelResizeCleanup: null,
    sessionHistory: new WeakMap(),
};

let tavernRuntimePromise = null;

function refreshContext() {
    const context = globalThis.SillyTavern?.getContext?.();
    if (context) state.context = context;
    return state.context;
}

function removeConfiguredReasoning(value) {
    if (typeof value !== 'string') return value;
    try {
        const parsed = state.context?.parseReasoningFromString?.(value, { strict: false });
        if (parsed && typeof parsed.content === 'string' && parsed.reasoning) return parsed.content;
    } catch (error) {
        console.warn('[Story Rewriter] public reasoning parser failed; using explicit-tag cleanup', error);
    }
    return value;
}

async function getTavernRuntime() {
    if (!tavernRuntimePromise) {
        const runtimeUrl = new URL('../../../../script.js', import.meta.url);
        tavernRuntimePromise = import(runtimeUrl.href).catch(error => {
            console.warn('[Story Rewriter] unable to load SillyTavern generation limits', error);
            return null;
        });
    }
    return tavernRuntimePromise;
}

async function getActiveGenerationLimits() {
    refreshContext();
    let maxContext = 0;
    let maxResponse = 0;
    let source = 'fallback';
    const runtime = await getTavernRuntime();
    try {
        maxContext = Number(runtime?.getMaxContextTokens?.()) || 0;
        maxResponse = Number(runtime?.getMaxResponseTokens?.()) || 0;
        if (maxContext > 0) source = 'preset';
    } catch (error) {
        console.warn('[Story Rewriter] unable to read active SillyTavern preset limits', error);
    }
    if (maxContext <= 0) maxContext = Number(state.context?.maxContext) || 0;
    return { maxContext, maxResponse, source };
}

async function countTokens(text) {
    refreshContext();
    if (typeof state.context?.getTokenCountAsync === 'function') {
        try {
            const count = Number(await state.context.getTokenCountAsync(String(text ?? '')));
            if (Number.isFinite(count) && count >= 0) return count;
        } catch (error) {
            console.warn('[Story Rewriter] current tokenizer failed; using conservative estimate', error);
        }
    }
    return estimateTokenCount(text);
}

function formatTokenCount(value) {
    const count = Math.max(0, Number(value) || 0);
    return count >= 100000
        ? `${(count / 10000).toLocaleString(undefined, { maximumFractionDigits: 1 })} 万 Token`
        : `${Math.round(count).toLocaleString()} Token`;
}

function desiredRevisionTokens(originalTokens) {
    return Math.min(
        state.settings.fullResponseLength,
        Math.max(1024, Math.ceil(originalTokens * 1.15) + 256),
    );
}

function notify(message, type = 'info') {
    const method = globalThis.toastr?.[type];
    if (typeof method === 'function') method(message, '故事改写');
    else console[type === 'error' ? 'error' : 'log'](`[Story Rewriter] ${message}`);
}

function generationLog(event, metadata = {}) {
    const allowed = [
        'stage', 'segment', 'attempt', 'responseLength', 'promptTokens',
        'elapsedMs', 'responseCharacters', 'complete', 'errorCode', 'stopReason',
    ];
    const safe = Object.fromEntries(allowed
        .filter(key => metadata[key] !== undefined)
        .map(key => [key, metadata[key]]));
    const method = event === 'error' || event === 'timeout' ? 'warn' : 'info';
    console[method](`[Story Rewriter][generation] ${event}`, safe);
    const session = state.session;
    if (session?.generationDiagnostics) {
        session.generationDiagnostics.push({ event, ...safe, createdAt: new Date().toISOString() });
        if (session.generationDiagnostics.length > 80) session.generationDiagnostics.shift();
    }
}

function startGenerationSession(session) {
    session.generationController?.abort(new GenerationCancelledError('新的生成已开始。'));
    session.cancelled = false;
    session.generationInProgress = true;
    session.generationController = new AbortController();
    session.partialCandidate = '';
    session.partialSegments = 0;
    session.generationDiagnostics = [];
}

function cancelGenerationSession(session, message = '已取消本次生成。') {
    if (!session) return;
    session.cancelled = true;
    const error = new GenerationCancelledError(message);
    if (!session.generationController?.signal.aborted) session.generationController?.abort(error);
    try {
        state.context?.stopGeneration?.();
    } catch (stopError) {
        console.warn('[Story Rewriter][generation] unable to stop host generation', stopError);
    }
}

async function runGenerationCall(session, stage, operation, metadata = {}) {
    if (session.cancelled) throw new GenerationCancelledError();
    return runGuardedGeneration({
        operation,
        timeoutMs: state.settings.generationTimeoutSeconds * 1000,
        signal: session.generationController?.signal,
        onTimeout: () => state.context?.stopGeneration?.(),
        logger: generationLog,
        metadata: { ...metadata, stage },
    });
}

function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function loadSettings() {
    const stored = state.context.extensionSettings?.[EXTENSION_KEY] ?? {};
    const storedVersion = Number(stored.settingsVersion ?? 0);
    const upgradingToV4 = storedVersion < 4;
    const upgradingToV5 = storedVersion < 5;
    const upgradingToV6 = storedVersion < 6;
    const upgradingToV7 = storedVersion < 7;
    const storedAnalysisLength = Number(stored.analysisResponseLength);
    const storedFullResponseLength = Number(stored.fullResponseLength);
    state.settings = {
        ...DEFAULT_SETTINGS,
        ...stored,
        settingsVersion: 7,
        enabled: stored.enabled ?? DEFAULT_SETTINGS.enabled,
        contextMode: upgradingToV4
            ? DEFAULT_SETTINGS.contextMode
            : CONTEXT_MODES.has(stored.contextMode) ? stored.contextMode : DEFAULT_SETTINGS.contextMode,
        contextCharacters: clampNumber(stored.contextCharacters, 0, 8000, DEFAULT_SETTINGS.contextCharacters),
        responseLength: clampNumber(stored.responseLength, 64, 4096, DEFAULT_SETTINGS.responseLength),
        fullResponseLength: upgradingToV6 && (!Number.isFinite(storedFullResponseLength) || storedFullResponseLength <= 8192)
            ? DEFAULT_SETTINGS.fullResponseLength
            : clampNumber(storedFullResponseLength, 512, 65536, DEFAULT_SETTINGS.fullResponseLength),
        persistentUndo: stored.persistentUndo ?? DEFAULT_SETTINGS.persistentUndo,
        defaultInfluence: IMPACT_LEVELS.includes(stored.defaultInfluence) ? stored.defaultInfluence : DEFAULT_SETTINGS.defaultInfluence,
        confirmImpact: stored.confirmImpact ?? DEFAULT_SETTINGS.confirmImpact,
        retrievalCharacters: clampNumber(stored.retrievalCharacters, 1000, 50000, DEFAULT_SETTINGS.retrievalCharacters),
        retrievalResults: clampNumber(stored.retrievalResults, 3, 40, DEFAULT_SETTINGS.retrievalResults),
        analysisResponseLength: upgradingToV5 && (!Number.isFinite(storedAnalysisLength) || storedAnalysisLength <= 1400)
            ? DEFAULT_SETTINGS.analysisResponseLength
            : clampNumber(storedAnalysisLength, 512, 4096, DEFAULT_SETTINGS.analysisResponseLength),
        generationTimeoutSeconds: clampNumber(stored.generationTimeoutSeconds, 30, 900, DEFAULT_SETTINGS.generationTimeoutSeconds),
    };
    state.context.extensionSettings[EXTENSION_KEY] = state.settings;
    if (upgradingToV4 || upgradingToV5 || upgradingToV6 || upgradingToV7) state.context.saveSettingsDebounced();
}

function saveSettings() {
    state.context.extensionSettings[EXTENSION_KEY] = state.settings;
    state.context.saveSettingsDebounced();
}

async function mountSettings() {
    if (document.querySelector('#story_rewriter_settings')) return;
    const host = document.querySelector('#extensions_settings');
    if (!host) throw new Error('找不到 SillyTavern 扩展设置容器。');
    const response = await fetch(new URL('./settings.html', import.meta.url));
    if (!response.ok) throw new Error(`加载设置失败：HTTP ${response.status}`);
    host.insertAdjacentHTML('beforeend', await response.text());

    const enabled = document.querySelector('#story_rewriter_enabled');
    const contextMode = document.querySelector('#story_rewriter_context_mode');
    const contextCharacters = document.querySelector('#story_rewriter_context_chars');
    const responseLength = document.querySelector('#story_rewriter_response_length');
    const fullResponseLength = document.querySelector('#story_rewriter_full_response_length');
    const persistentUndo = document.querySelector('#story_rewriter_persistent_undo');
    const retrievalCharacters = document.querySelector('#story_rewriter_retrieval_chars');
    const retrievalResults = document.querySelector('#story_rewriter_retrieval_results');
    const analysisResponseLength = document.querySelector('#story_rewriter_analysis_length');
    const generationTimeoutSeconds = document.querySelector('#story_rewriter_generation_timeout');
    enabled.checked = state.settings.enabled;
    contextMode.value = state.settings.contextMode;
    contextCharacters.value = String(state.settings.contextCharacters);
    responseLength.value = String(state.settings.responseLength);
    fullResponseLength.value = String(state.settings.fullResponseLength);
    persistentUndo.checked = state.settings.persistentUndo;
    retrievalCharacters.value = String(state.settings.retrievalCharacters);
    retrievalResults.value = String(state.settings.retrievalResults);
    analysisResponseLength.value = String(state.settings.analysisResponseLength);
    generationTimeoutSeconds.value = String(state.settings.generationTimeoutSeconds);

    enabled.addEventListener('change', () => {
        state.settings.enabled = enabled.checked;
        if (!enabled.checked) hideActionButton();
        saveSettings();
        ensureMessageButtons();
    });
    contextMode.addEventListener('change', () => {
        state.settings.contextMode = CONTEXT_MODES.has(contextMode.value) ? contextMode.value : DEFAULT_SETTINGS.contextMode;
        saveSettings();
    });
    contextCharacters.addEventListener('change', () => {
        state.settings.contextCharacters = clampNumber(contextCharacters.value, 0, 8000, DEFAULT_SETTINGS.contextCharacters);
        contextCharacters.value = String(state.settings.contextCharacters);
        saveSettings();
    });
    responseLength.addEventListener('change', () => {
        state.settings.responseLength = clampNumber(responseLength.value, 64, 4096, DEFAULT_SETTINGS.responseLength);
        responseLength.value = String(state.settings.responseLength);
        saveSettings();
    });
    fullResponseLength.addEventListener('change', () => {
        state.settings.fullResponseLength = clampNumber(fullResponseLength.value, 512, 65536, DEFAULT_SETTINGS.fullResponseLength);
        fullResponseLength.value = String(state.settings.fullResponseLength);
        saveSettings();
    });
    persistentUndo.addEventListener('change', () => {
        state.settings.persistentUndo = persistentUndo.checked;
        saveSettings();
        ensureMessageButtons();
    });
    retrievalCharacters.addEventListener('change', () => {
        state.settings.retrievalCharacters = clampNumber(retrievalCharacters.value, 1000, 50000, DEFAULT_SETTINGS.retrievalCharacters);
        retrievalCharacters.value = String(state.settings.retrievalCharacters);
        saveSettings();
    });
    retrievalResults.addEventListener('change', () => {
        state.settings.retrievalResults = clampNumber(retrievalResults.value, 3, 40, DEFAULT_SETTINGS.retrievalResults);
        retrievalResults.value = String(state.settings.retrievalResults);
        saveSettings();
    });
    analysisResponseLength.addEventListener('change', () => {
        state.settings.analysisResponseLength = clampNumber(analysisResponseLength.value, 512, 4096, DEFAULT_SETTINGS.analysisResponseLength);
        analysisResponseLength.value = String(state.settings.analysisResponseLength);
        saveSettings();
    });
    generationTimeoutSeconds.addEventListener('change', () => {
        state.settings.generationTimeoutSeconds = clampNumber(generationTimeoutSeconds.value, 30, 900, DEFAULT_SETTINGS.generationTimeoutSeconds);
        generationTimeoutSeconds.value = String(state.settings.generationTimeoutSeconds);
        saveSettings();
    });
}

function createActionButton() {
    const host = document.createElement('div');
    host.id = 'story-rewriter-action';
    host.className = 'story-rewriter-action story-rewriter-ui';
    host.hidden = true;
    host.innerHTML = `
        <button type="button" data-edit-mode="semantic" title="修改选中的故事内容"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>修改</span></button>`;
    host.addEventListener('mousedown', event => event.preventDefault());
    host.addEventListener('click', event => {
        const mode = event.target.closest?.('[data-edit-mode]')?.dataset.editMode;
        if (EDIT_MODES.has(mode)) openRewriteWorkspace(mode);
    });
    document.body.append(host);
    state.actionButton = host;
}

function hideActionButton() {
    if (state.actionButton) state.actionButton.hidden = true;
}

function showActionButton(rect) {
    const button = state.actionButton;
    button.hidden = false;
    const width = button.offsetWidth || 112;
    const height = button.offsetHeight || 36;
    const left = Math.min(window.innerWidth - width - 8, Math.max(8, rect.left + rect.width / 2 - width / 2));
    const top = Math.min(window.innerHeight - height - 8, Math.max(8, rect.bottom + 8));
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
}

function closestMessageText(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return element?.closest?.('.mes_text') ?? null;
}

function captureSelection() {
    if (!state.active || !state.settings.enabled || state.panel || state.selectionPointerDown) return hideActionButton();
    refreshContext();
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return hideActionButton();
    const range = selection.getRangeAt(0);
    const startText = closestMessageText(range.startContainer);
    const endText = closestMessageText(range.endContainer);
    if (!startText || startText !== endText) return hideActionButton();

    const messageElement = startText.closest('.mes');
    const messageId = Number(messageElement?.getAttribute('mesid'));
    const message = state.context.chat?.[messageId];
    if (!Number.isInteger(messageId) || !message || message.is_user || message.is_system) return hideActionButton();
    if (typeof message.mes !== 'string') return hideActionButton();
    if (typeof message.extra?.display_text === 'string' && message.extra.display_text !== message.mes) return hideActionButton();

    const selectedText = selection.toString();
    if (!selectedText.trim()) return hideActionButton();
    const prefixRange = document.createRange();
    prefixRange.selectNodeContents(startText);
    prefixRange.setEnd(range.startContainer, range.startOffset);
    const visibleStart = prefixRange.toString().length;
    const rawRange = findSelectionRange(message.mes, selectedText, visibleStart);
    if (!rawRange) return hideActionButton();

    const clientRects = Array.from(range.getClientRects());
    const rect = chooseVisibleSelectionRect(clientRects, window.innerWidth, window.innerHeight)
        ?? (clientRects.length === 0
            ? chooseVisibleSelectionRect([range.getBoundingClientRect()], window.innerWidth, window.innerHeight)
            : null);
    if (!rect) return hideActionButton();
    state.capture = {
        message,
        messageId,
        messageText: message.mes,
        selectedText,
        range: rawRange,
    };
    showActionButton(rect);
}

function scheduleSelectionCapture(delay = 0, releaseStuckPointer = false) {
    window.clearTimeout(state.selectionCaptureTimer);
    state.selectionCaptureTimer = window.setTimeout(() => {
        state.selectionCaptureTimer = null;
        if (releaseStuckPointer) state.selectionPointerDown = false;
        captureSelection();
    }, delay);
}

function onSelectionPointerDown(event) {
    if (event.target?.closest?.('.story-rewriter-ui')) return;
    state.selectionPointerDown = true;
    hideActionButton();
}

function onSelectionPointerUp(event) {
    state.selectionPointerDown = false;
    if (event.target?.closest?.('.story-rewriter-ui')) return;
    scheduleSelectionCapture(0);
}

function onSelectionKeyUp(event) {
    if (event.target?.closest?.('.story-rewriter-ui')) return;
    scheduleSelectionCapture(0);
}

function onSelectionChange() {
    if (!state.active || state.selectionPointerDown) return;
    scheduleSelectionCapture(40);
}

function onViewportScroll() {
    hideActionButton();
    // Auto-scroll selection can release outside the document, so pointerup may
    // never reach us. Once scrolling settles, trust the live DOM selection and
    // clear a stale pointer-down state before recapturing it.
    scheduleSelectionCapture(180, true);
}

function onViewportResize() {
    hideActionButton();
    scheduleSelectionCapture(120);
}

function onWindowBlur() {
    state.selectionPointerDown = false;
    scheduleSelectionCapture(80);
}

function closeWorkspace() {
    if (state.session?.generationInProgress) cancelGenerationSession(state.session, '工作台已关闭。');
    state.panelResizeCleanup?.();
    state.panelResizeCleanup = null;
    state.panel?.remove();
    state.panel = null;
    state.session = null;
    hideActionButton();
}

function enablePanelResize(panel) {
    const handle = panel.querySelector('.story-rewriter-resize-handle');
    if (!handle) return;
    handle.addEventListener('pointerdown', event => {
        if (window.matchMedia('(max-width: 700px)').matches) return;
        event.preventDefault();
        state.panelResizeCleanup?.();
        const startX = event.clientX;
        const startWidth = panel.getBoundingClientRect().width;
        const onMove = moveEvent => {
            const maximum = window.innerWidth * 0.96;
            const width = Math.min(maximum, Math.max(420, startWidth + startX - moveEvent.clientX));
            panel.style.width = `${width}px`;
        };
        const cleanup = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', cleanup);
            window.removeEventListener('pointercancel', cleanup);
            panel.classList.remove('is-resizing');
            if (state.panelResizeCleanup === cleanup) state.panelResizeCleanup = null;
        };
        state.panelResizeCleanup = cleanup;
        panel.classList.add('is-resizing');
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', cleanup, { once: true });
        window.addEventListener('pointercancel', cleanup, { once: true });
    });
}

function setWorkspaceBusy(panel, busy, status = '', { cancelable = false } = {}) {
    panel.dataset.busy = String(busy);
    panel.querySelectorAll('button, select, input').forEach(element => {
        element.disabled = busy
            ? !element.classList.contains('story-rewriter-cancel')
            : element.dataset.permanentDisabled === 'true';
    });
    panel.querySelectorAll('textarea').forEach(element => {
        if (!element.classList.contains('story-rewriter-original')) element.disabled = busy;
    });
    if (!busy) {
        const candidate = panel.querySelector('.story-rewriter-candidate');
        const apply = panel.querySelector('.story-rewriter-apply');
        if (candidate && apply) apply.disabled = !candidate.value.trim();
        panel.querySelector('.story-rewriter-replace')?.toggleAttribute('disabled', !candidate?.value.trim());
    }
    panel.querySelector('.story-rewriter-cancel')?.toggleAttribute('hidden', !busy || !cancelable);
    panel.querySelector('.story-rewriter-status').textContent = status;
}

function renderSessionTurns(panel) {
    const host = panel.querySelector('.story-rewriter-turns');
    host.replaceChildren();
    for (const [index, turn] of state.session.turns.entries()) {
        const card = document.createElement('article');
        card.className = 'story-rewriter-turn';
        const requestLabel = document.createElement('strong');
        requestLabel.textContent = `第 ${index + 1} 轮要求`;
        const request = document.createElement('p');
        request.textContent = turn.instruction;
        const resultLabel = document.createElement('strong');
        resultLabel.textContent = '候选摘要';
        const result = document.createElement('p');
        result.textContent = turn.candidate.length > 180 ? `${turn.candidate.slice(0, 180)}…` : turn.candidate;
        const restore = document.createElement('button');
        restore.type = 'button';
        restore.className = 'menu_button story-rewriter-restore-candidate';
        restore.textContent = '恢复这个候选';
        restore.addEventListener('click', () => {
            panel.querySelector('.story-rewriter-preview').hidden = false;
            if (state.session.scopeMode === 'selection') {
                state.session.candidate = turn.candidate;
                panel.querySelector('.story-rewriter-candidate').value = turn.candidate;
                panel.querySelector('.story-rewriter-apply').disabled = false;
            } else {
                if (turn.impactPlan) {
                    state.session.impactPlan = cloneValue(turn.impactPlan);
                    state.session.reviewPlan = cloneValue(turn.impactPlan);
                    renderImpactPlan(panel);
                }
                state.session.generationIncomplete = Boolean(turn.generationIncomplete);
                state.session.generationIncompleteReason = String(turn.generationIncompleteReason ?? '');
                state.session.generationSegments = Number(turn.generationSegments) || 1;
                initializeCandidateReview(panel, turn.candidate);
                switchWorkspaceView(panel, 'changes');
            }
            panel.querySelector('.story-rewriter-status').textContent = `已恢复第 ${index + 1} 轮候选并重新审计。`;
        });
        card.append(requestLabel, request, resultLabel, result, restore);
        host.append(card);
    }
    host.hidden = state.session.turns.length === 0;
}

function updateContextSummary(panel) {
    const fullContext = state.session.contextMode === 'tavern';
    const limit = state.session.activeLimits?.maxContext;
    const responseLimit = state.session.activeLimits?.maxResponse;
    const limitLabel = limit
        ? ` · ${state.session.activeLimits.source === 'preset' ? '当前预设' : '兼容上限'} ${formatTokenCount(limit)}`
        : '';
    const responseLabel = responseLimit ? ` · 响应上限 ${formatTokenCount(responseLimit)}` : '';
    panel.querySelector('.story-rewriter-context-summary').textContent = (fullContext
        ? '酒馆当前生效上下文 · 当前完整消息 · 按需历史证据'
        : '当前完整消息 · 当前角色事实 · 酒馆激活世界书快照 · 按需历史证据') + limitLabel + responseLabel;
    const timelineNotice = panel.querySelector('.story-rewriter-timeline-notice');
    timelineNotice.hidden = !fullContext || state.session.capture.messageId >= state.context.chat.length - 1;
}

async function syncContextSummary(panel) {
    const session = state.session;
    const limits = await getActiveGenerationLimits();
    if (state.session !== session || !panel.isConnected) return limits;
    session.activeLimits = limits;
    updateContextSummary(panel);
    return limits;
}

function applyAutomaticContextFallback(panel) {
    if (state.session?.contextMode !== 'tavern' || typeof state.context.generateQuietPrompt === 'function') return false;
    state.session.contextMode = 'local';
    updateContextSummary(panel);
    return true;
}

function resetSessionForScopeChange(panel) {
    const session = state.session;
    if (!session) return;
    session.candidate = '';
    session.requirements = [];
    session.turns = [];
    session.repository = null;
    session.impactPlan = null;
    session.reviewPlan = null;
    session.audit = null;
    session.pendingTask = null;
    session.pendingInstruction = '';
    session.proposalCandidate = '';
    session.reviewAudit = null;
    session.acceptedChangeIds = new Set();
    session.generationIncomplete = false;
    session.generationIncompleteReason = '';
    session.generationSegments = 0;
    session.partialCandidate = '';
    session.partialSegments = 0;
    session.generationDiagnostics = [];
    panel.querySelector('.story-rewriter-candidate').value = '';
    panel.querySelector('.story-rewriter-preview').hidden = true;
    panel.querySelector('.story-rewriter-impact').hidden = true;
    panel.querySelector('.story-rewriter-apply').disabled = true;
    panel.querySelector('.story-rewriter-replace').disabled = true;
    panel.querySelector('.story-rewriter-generate').hidden = false;
    renderSessionTurns(panel);
}

function updateScopeInterface(panel) {
    const selectionOnly = state.session?.scopeMode === 'selection';
    panel.classList.toggle('is-selection-scope', selectionOnly);
    panel.querySelector('.story-rewriter-view-tabs').hidden = selectionOnly;
    panel.querySelector('.story-rewriter-advanced-actions').hidden = selectionOnly;
    panel.querySelectorAll('.story-rewriter-view').forEach(section => {
        section.hidden = section.dataset.view !== 'full';
    });
    panel.querySelectorAll('.story-rewriter-view-tab').forEach(button => {
        button.classList.toggle('is-active', button.dataset.view === 'full');
    });
}

function buildSessionTask(instruction, panel) {
    const { capture } = state.session;
    const task = createRewriteTask(capture.messageText, capture.range, instruction, state.settings.contextCharacters);
    return {
        ...task,
        constraints: panel.querySelector('.story-rewriter-constraints').value.trim(),
        previousCandidate: panel.querySelector('.story-rewriter-candidate').value.trim() || state.session.candidate,
        previousInstructions: state.session.requirements.slice(-MAX_SESSION_TURNS),
    };
}

async function generatePreciseCandidate(panel) {
    const session = state.session;
    const instructionInput = panel.querySelector('.story-rewriter-instruction');
    const instruction = instructionInput.value.trim();
    if (!instruction) {
        panel.querySelector('.story-rewriter-status').textContent = '请先输入本轮修改要求。';
        return;
    }
    const capture = session?.capture;
    if (!captureIsCurrent(capture)) {
        panel.querySelector('.story-rewriter-status').textContent = '原消息已变化，请关闭工作台后重新选择。';
        return;
    }

    startGenerationSession(session);
    const fellBack = applyAutomaticContextFallback(panel);
    setWorkspaceBusy(panel, true, session.contextMode === 'tavern'
        ? '正在通过酒馆完整上下文调用当前模型…'
        : fellBack ? '完整上下文接口不可用，已降级到插件资料模式…' : '正在通过插件资料模式调用当前模型…', { cancelable: true });
    try {
        await syncContextSummary(panel);
        const task = buildSessionTask(instruction, panel);
        const requestReplacement = async useSchema => {
            const fallbackContract = useSchema ? '' : '\n\n当前后端可能不支持 JSON Schema。只在 <story_rewriter_replacement_begin> 和 <story_rewriter_replacement_end> 之间输出替换正文，不要 JSON、解释或代码围栏。';
            return runGenerationCall(session, '局部替换', () => {
                if (session.contextMode === 'tavern' && typeof state.context.generateQuietPrompt === 'function') {
                    return state.context.generateQuietPrompt({
                        quietPrompt: `${buildFullContextRewritePrompt(task)}${fallbackContract}`,
                        quietToLoud: false,
                        skipWIAN: false,
                        responseLength: state.settings.responseLength,
                        jsonSchema: useSchema ? REPLACEMENT_JSON_SCHEMA : null,
                        removeReasoning: true,
                        trimToSentence: false,
                    });
                }
                if (typeof state.context.generateRaw !== 'function') throw new Error('当前 SillyTavern 不提供可用的后台生成接口。');
                return state.context.generateRaw({
                    systemPrompt: DEFAULT_SYSTEM_PROMPT,
                    prompt: `${buildRewritePrompt(task)}${fallbackContract}`,
                    responseLength: state.settings.responseLength,
                    jsonSchema: useSchema ? REPLACEMENT_JSON_SCHEMA : null,
                    trimNames: false,
                });
            }, {
                attempt: useSchema ? 1 : 2,
                responseLength: state.settings.responseLength,
            });
        };
        let response = await requestReplacement(true);
        if (session.cancelled) throw new GenerationCancelledError();
        let candidate = cleanModelResponse(removeConfiguredReasoning(response));
        if (!candidate) {
            panel.querySelector('.story-rewriter-status').textContent = '当前模型未返回可用的结构化替换，正在切换纯文本协议…';
            response = await requestReplacement(false);
            if (session.cancelled) throw new GenerationCancelledError();
            candidate = cleanModelResponse(removeConfiguredReasoning(response));
        }
        if (!candidate) throw new Error('模型返回了空内容。');
        if (state.session !== session || !panel.isConnected) return;
        session.candidate = candidate;
        session.constraints = task.constraints;
        session.requirements.push(instruction);
        if (session.requirements.length > MAX_SESSION_TURNS) session.requirements.shift();
        session.turns.push({ instruction, candidate, createdAt: new Date().toISOString() });
        if (session.turns.length > MAX_SESSION_TURNS) session.turns.shift();
        panel.querySelector('.story-rewriter-candidate').value = candidate;
        panel.querySelector('.story-rewriter-preview').hidden = false;
        panel.querySelector('.story-rewriter-apply').disabled = false;
        instructionInput.value = '';
        renderSessionTurns(panel);
        panel.querySelector('.story-rewriter-status').textContent = '新版本已生成。可以继续提出要求或应用为新版本。';
    } catch (error) {
        console.error('[Story Rewriter] generation failed', error);
        panel.querySelector('.story-rewriter-status').textContent = isGenerationCancelled(error)
            ? '已取消本次生成。'
            : `生成失败：${error.message ?? error}`;
    } finally {
        session.generationInProgress = false;
        if (panel.isConnected && state.panel === panel) {
            setWorkspaceBusy(panel, false, panel.querySelector('.story-rewriter-status').textContent);
        }
    }
}

function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function hashText(text) {
    let hash = 2166136261;
    for (const character of String(text ?? '')) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function captureIsCurrent(capture) {
    refreshContext();
    if (!capture || state.context.chat?.[capture.messageId] !== capture.message) return false;
    if (capture.chatId !== state.context.chatId) return false;
    if (capture.swipeId !== (capture.message.swipe_id ?? null)) return false;
    return capture.message.mes === capture.messageText && hashText(capture.message.mes) === capture.messageHash;
}

function getRepositoryCharacters() {
    refreshContext();
    if (state.context.groupId !== null && state.context.groupId !== undefined && state.context.groupId !== '') {
        const group = state.context.groups?.find(item => String(item.id) === String(state.context.groupId));
        const members = new Set(group?.members ?? []);
        return Array.from(state.context.characters ?? []).filter(character => members.has(character.avatar));
    }
    const character = state.context.characters?.[Number(state.context.characterId)];
    return character ? [character] : [];
}

async function loadActivatedWorldInfoEvidence(maxContext) {
    if (typeof state.context.getWorldInfoPrompt !== 'function') {
        return { chunks: [], failures: ['当前版本未公开世界书激活接口'] };
    }
    try {
        const result = await state.context.getWorldInfoPrompt(
            state.context.chat ?? [],
            maxContext || Number(state.context.maxContext) || 65536,
            true,
        );
        return { chunks: createActivatedWorldInfoChunks(result), failures: [] };
    } catch (error) {
        console.warn('[Story Rewriter] unable to build activated world-info snapshot', error);
        return { chunks: [], failures: ['当前激活世界书快照'] };
    }
}

async function buildSemanticRepository(session, instruction, constraints) {
    refreshContext();
    const limits = session.activeLimits ?? await getActiveGenerationLimits();
    session.activeLimits = limits;
    const chunks = [...createChatChunks(state.context.chat, session.capture.messageId)];
    let failures = [];
    if (session.contextMode === 'local') {
        const characters = getRepositoryCharacters();
        const activatedWorld = await loadActivatedWorldInfoEvidence(limits.maxContext);
        chunks.push(...createCharacterChunks(characters), ...activatedWorld.chunks);
        failures = activatedWorld.failures;
    }
    const query = [
        instruction,
        session.capture.selectedText,
        constraints,
        ...session.requirements.slice(-3),
    ].filter(Boolean).join('\n');
    const originalTokens = await countTokens(session.capture.messageText);
    const desiredOutput = desiredRevisionTokens(originalTokens);
    const maxContext = limits.maxContext;
    const baseTokens = await countTokens([session.capture.messageText, instruction, constraints].join('\n')) + 1800;
    const availableRetrievalTokens = maxContext ? maxContext - baseTokens - desiredOutput : Number.POSITIVE_INFINITY;
    const contextCharacterBudget = Number.isFinite(availableRetrievalTokens)
        ? Math.max(0, Math.floor(availableRetrievalTokens * 2))
        : state.settings.retrievalCharacters;
    const retrievalBudget = Math.min(state.settings.retrievalCharacters, contextCharacterBudget);
    const retrieval = retrievalBudget >= 500
        ? retrieveReferences(chunks, query, {
            maxResults: state.settings.retrievalResults,
            maxCharacters: retrievalBudget,
        })
        : { items: [], totalMatches: 0, omitted: 0, characters: 0, queryTokens: [] };
    return {
        retrieval,
        sourceCounts: chunks.reduce((counts, chunk) => {
            counts[chunk.sourceType] = (counts[chunk.sourceType] ?? 0) + 1;
            return counts;
        }, {}),
        failures,
        budgetLimited: retrievalBudget < state.settings.retrievalCharacters,
        retrievalBudget,
    };
}

async function generateStructured(prompt, schema, responseLength, parser, session, stageLabel) {
    let currentPrompt = prompt;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (session.cancelled) throw new GenerationCancelledError();
        const response = await runGenerationCall(session, stageLabel, () => {
            if (session.contextMode === 'tavern' && typeof state.context.generateQuietPrompt === 'function') {
                return state.context.generateQuietPrompt({
                    quietPrompt: currentPrompt,
                    quietToLoud: false,
                    skipWIAN: false,
                    responseLength,
                    jsonSchema: attempt === 0 ? schema : null,
                    removeReasoning: true,
                    trimToSentence: false,
                });
            }
            if (typeof state.context.generateRaw !== 'function') throw new Error('当前 SillyTavern 不提供可用的后台生成接口。');
            return state.context.generateRaw({
                systemPrompt: attempt === 0
                    ? 'You are a source-grounded fiction editing agent. Follow the JSON schema and never reveal hidden reasoning.'
                    : 'You are a source-grounded fiction editing agent. Return one compact JSON object between the requested boundary markers and never reveal hidden reasoning.',
                prompt: currentPrompt,
                responseLength,
                jsonSchema: attempt === 0 ? schema : null,
                trimNames: false,
            });
        }, { attempt: attempt + 1, responseLength });
        if (session.cancelled) throw new GenerationCancelledError();
        try {
            return parser(removeConfiguredReasoning(response));
        } catch (error) {
            lastError = error;
            if (attempt === 0) {
                const truncationHint = stageLabel === '影响分析' && /unterminated|unexpected end|end of json|截断/i.test(String(error.message ?? error))
                    ? '上次输出疑似被截断。必须大幅压缩：不要复制原文，不要输出引句，每个理由只写一句，省略低置信度关联，确保 JSON 完整闭合。'
                    : '';
                currentPrompt = `${prompt}\n\n<format_retry>上一次${stageLabel}没有返回可解析的数据：${String(error.message ?? error)}。${truncationHint}当前后端可能不支持 JSON Schema。重新执行原任务，在 <story_rewriter_json_begin> 与 <story_rewriter_json_end> 之间只放一个完整、紧凑的 JSON 对象，不要代码围栏或解释。</format_retry>`;
            }
        }
    }
    if (stageLabel === '影响分析' && /json|unterminated|unexpected end|截断/i.test(String(lastError?.message ?? lastError))) {
        throw new Error('模型连续两次返回了不完整的影响分析数据，通常是响应被截断。请提高当前预设的最大响应 Token，或减少按需资料条数。');
    }
    throw lastError ?? new Error(`${stageLabel}失败。`);
}

async function generatePlain(prompt, responseLength, session, metadata = {}) {
    if (session.cancelled) throw new GenerationCancelledError();
    const response = await runGenerationCall(session, '完整正文', () => {
        if (session.contextMode === 'tavern' && typeof state.context.generateQuietPrompt === 'function') {
            return state.context.generateQuietPrompt({
                quietPrompt: prompt,
                quietToLoud: false,
                skipWIAN: false,
                responseLength,
                // Some model/preset combinations classify the entire final answer as
                // reasoning. Keep the raw text here and remove only explicit blocks
                // in parseRevisionTextSegment so valid story text is not erased.
                removeReasoning: false,
                trimToSentence: false,
            });
        }
        if (typeof state.context.generateRaw !== 'function') throw new Error('当前 SillyTavern 不提供可用的后台生成接口。');
        return state.context.generateRaw({
            systemPrompt: 'You are a source-grounded fiction editing agent. Output only the requested story text and terminal marker. Never reveal hidden reasoning.',
            prompt,
            responseLength,
            trimNames: false,
        });
    }, { ...metadata, responseLength });
    if (session.cancelled) throw new GenerationCancelledError();
    return String(removeConfiguredReasoning(String(response ?? '')) ?? '');
}

function getEffectiveImpactPlan(plan) {
    return {
        ...plan,
        linkedRegions: plan.linkedRegions.filter(region => region.enabled !== false),
        transitionRegions: plan.transitionRegions.filter(region => region.enabled !== false),
    };
}

function getSessionReviewPlan(session) {
    return getEffectiveImpactPlan(session.reviewPlan ?? session.impactPlan);
}

function createCandidateAudit(session, candidate) {
    const audit = auditRevision(session.capture.messageText, candidate, getSessionReviewPlan(session));
    if (session.generationIncomplete) {
        audit.conflicts.unshift(session.generationIncompleteReason
            || '完整正文未通过完整性检查。请检查文章结尾；你仍可编辑或确认应用。');
        audit.hardBlocked = true;
        audit.requiresOverride = false;
    }
    return audit;
}

function renderImpactPlan(panel) {
    const host = panel.querySelector('.story-rewriter-impact-content');
    host.replaceChildren();
    const session = state.session;
    const plan = session?.impactPlan;
    if (!plan) return;

    const summary = document.createElement('p');
    summary.className = 'story-rewriter-impact-summary';
    summary.textContent = `目标：${plan.objective || '按本轮要求重构'}；强修改 ${plan.focusRegions.length} 段，关联 ${plan.linkedRegions.length} 段，衔接 ${plan.transitionRegions.length} 段。`;
    host.append(summary);
    if (plan.fallback) {
        const fallback = document.createElement('p');
        fallback.className = 'story-rewriter-warning';
        fallback.textContent = '模型的结构化分析不可用，当前采用本地保守范围。置信度不会决定替换权限，请在逐块确认中选择。';
        host.append(fallback);
    }
    if (session.repository?.budgetLimited) {
        const budget = document.createElement('p');
        budget.className = 'story-rewriter-warning';
        budget.textContent = session.repository.retrievalBudget >= 500
            ? `资料字符预算已按当前模型上下文缩减为约 ${session.repository.retrievalBudget} 字。`
            : '当前完整消息与输出预算已接近模型上下文上限，本轮没有附加按需资料。';
        host.append(budget);
    }

    const appendRegions = (title, regions, selectable, className) => {
        if (!regions.length) return;
        const group = document.createElement('section');
        group.className = `story-rewriter-impact-group ${className}`;
        const heading = document.createElement('strong');
        heading.textContent = title;
        group.append(heading);
        for (const region of regions) {
            const label = document.createElement('label');
            label.className = 'story-rewriter-impact-region';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = region.enabled !== false;
            input.disabled = !selectable;
            if (!selectable) input.dataset.permanentDisabled = 'true';
            input.addEventListener('change', () => {
                region.enabled = input.checked;
            });
            const text = document.createElement('span');
            const confidence = typeof region.confidence === 'number' ? ` · 模型参考 ${Math.round(region.confidence * 100)}%` : '';
            text.textContent = `${region.paragraphId}${confidence} — ${region.reason}`;
            label.append(input, text);
            group.append(label);
        }
        host.append(group);
    };

    appendRegions('强修改区', plan.focusRegions, false, 'is-focus');
    appendRegions('关联修改区', plan.linkedRegions, true, 'is-linked');
    appendRegions('过渡调整区', plan.transitionRegions, true, 'is-transition');

    if (plan.protectedFacts.length) {
        const group = document.createElement('section');
        group.className = 'story-rewriter-impact-group is-protected';
        const heading = document.createElement('strong');
        heading.textContent = '保护事实';
        const list = document.createElement('ul');
        for (const item of plan.protectedFacts) {
            const entry = document.createElement('li');
            entry.textContent = `${item.strength === 'hard' ? '硬保护' : '软保护'}：${item.fact}`;
            list.append(entry);
        }
        group.append(heading, list);
        host.append(group);
    }
    panel.querySelector('.story-rewriter-impact').hidden = false;
}

function renderReferences(panel) {
    const host = panel.querySelector('.story-rewriter-sources');
    host.replaceChildren();
    const session = state.session;
    const retrieval = session.repository?.retrieval;
    const summary = document.createElement('p');
    summary.textContent = retrieval?.items?.length
        ? `本次使用 ${retrieval.items.length} 条按需资料，另有 ${retrieval.omitted} 条匹配资料因数量或字符预算未发送。`
        : '没有检索到额外资料；仍会使用当前完整消息和酒馆正常组装的上下文。';
    host.append(summary);
    if (session.contextMode === 'tavern') {
        const quiet = document.createElement('p');
        quiet.textContent = '完整上下文模式还会沿用 SillyTavern 本次实际激活的角色卡、世界书、作者注和扩展提示。';
        host.append(quiet);
    }
    if (session.repository?.failures?.length) {
        const warning = document.createElement('p');
        warning.className = 'story-rewriter-warning';
        warning.textContent = `本地降级资料未能读取：${session.repository.failures.join('、')}。`;
        host.append(warning);
    }
    const list = document.createElement('ul');
    for (const item of retrieval?.items ?? []) {
        const entry = document.createElement('li');
        const label = document.createElement('strong');
        label.textContent = item.sourceLabel;
        const excerpt = document.createElement('span');
        excerpt.textContent = ` — ${item.text.length > 150 ? `${item.text.slice(0, 150)}…` : item.text}`;
        entry.append(label, excerpt);
        list.append(entry);
    }
    host.append(list);
}

function updateAuditPresentation(panel) {
    const session = state.session;
    const audit = session?.audit;
    const summary = panel.querySelector('.story-rewriter-audit-summary');
    const messagesHost = panel.querySelector('.story-rewriter-audit-messages');
    if (!audit) {
        summary.textContent = '';
        messagesHost?.replaceChildren();
        return;
    }
    const decisionNotice = audit.hardBlocked || audit.requiresOverride ? ' · 审计仅作提示，最终由你决定' : '';
    summary.textContent = `合成稿：强修改 ${audit.counts.focus} 处 · 关联修改 ${audit.counts.linked} 处 · 衔接调整 ${audit.counts.transition} 处 · 疑似越界 ${audit.counts.protected} 处${decisionNotice}`;
    summary.className = `story-rewriter-audit-summary${audit.hardBlocked ? ' is-blocked' : audit.requiresOverride ? ' is-warning' : ''}`;
    if (!messagesHost) return;
    messagesHost.replaceChildren();
    for (const message of [...audit.conflicts, ...audit.warnings]) {
        const warning = document.createElement('p');
        warning.className = audit.conflicts.includes(message) ? 'story-rewriter-conflict' : 'story-rewriter-warning';
        warning.textContent = message;
        messagesHost.append(warning);
    }
}

function updateReviewSelectionPresentation(panel) {
    const session = state.session;
    const changes = session?.reviewAudit?.changes ?? [];
    const accepted = session?.acceptedChangeIds ?? new Set();
    const count = panel.querySelector('.story-rewriter-review-count');
    if (count) count.textContent = `已采用 ${accepted.size}/${changes.length} 项修改`;
    panel.querySelectorAll('[data-review-change-id]').forEach(input => {
        input.checked = accepted.has(input.dataset.reviewChangeId);
    });
}

function composeReviewCandidate(panel) {
    const session = state.session;
    if (!session?.proposalCandidate || !session.reviewAudit) return;
    const candidate = composeRevisionFromDecisions(
        session.capture.messageText,
        session.proposalCandidate,
        session.acceptedChangeIds,
    );
    session.candidate = candidate;
    panel.querySelector('.story-rewriter-candidate').value = candidate;
    session.audit = createCandidateAudit(session, candidate);
    updateAuditPresentation(panel);
    updateReviewSelectionPresentation(panel);
    panel.querySelector('.story-rewriter-apply').disabled = !candidate.trim();
    panel.querySelector('.story-rewriter-replace').disabled = !candidate.trim();
}

function setReviewAcceptance(panel, predicate) {
    const session = state.session;
    if (!session?.reviewAudit) return;
    session.acceptedChangeIds = new Set(
        session.reviewAudit.changes.filter(predicate).map(change => change.id),
    );
    composeReviewCandidate(panel);
}

function renderAudit(panel) {
    const session = state.session;
    const review = session?.reviewAudit;
    const host = panel.querySelector('.story-rewriter-diff-content');
    host.replaceChildren();
    if (!review) {
        updateAuditPresentation(panel);
        return;
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'story-rewriter-review-toolbar';
    const count = document.createElement('strong');
    count.className = 'story-rewriter-review-count';
    const actions = document.createElement('div');
    actions.className = 'story-rewriter-review-actions';
    const addAction = (label, predicate) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'menu_button';
        button.textContent = label;
        button.addEventListener('click', () => setReviewAcceptance(panel, predicate));
        actions.append(button);
    };
    addAction('仅采用计划内', change => change.classification !== 'protected');
    addAction('全部采用', () => true);
    addAction('全部保留原文', () => false);
    toolbar.append(count, actions);

    const messages = document.createElement('div');
    messages.className = 'story-rewriter-audit-messages';
    const list = document.createElement('div');
    list.className = 'story-rewriter-review-list';
    const names = { focus: '强修改', linked: '关联修改', transition: '衔接调整', protected: '疑似越界' };
    for (const change of review.changes) {
        const card = document.createElement('article');
        card.className = `story-rewriter-diff-card is-${change.classification}`;
        const heading = document.createElement('div');
        heading.className = 'story-rewriter-diff-heading';
        const title = document.createElement('strong');
        title.textContent = `${names[change.classification]} · ${change.originalId ?? change.anchorId ?? '新增段落'}`;
        const decision = document.createElement('label');
        decision.className = 'story-rewriter-change-decision';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.reviewChangeId = change.id;
        input.checked = session.acceptedChangeIds.has(change.id);
        input.addEventListener('change', () => {
            if (input.checked) session.acceptedChangeIds.add(change.id);
            else session.acceptedChangeIds.delete(change.id);
            composeReviewCandidate(panel);
        });
        const decisionText = document.createElement('span');
        decisionText.textContent = '采用此修改';
        decision.append(input, decisionText);
        heading.append(title, decision);

        const pair = document.createElement('div');
        pair.className = 'story-rewriter-diff-pair';
        const makeVersion = (label, text, emptyLabel) => {
            const section = document.createElement('div');
            const caption = document.createElement('span');
            caption.className = 'story-rewriter-diff-caption';
            caption.textContent = label;
            const content = document.createElement('pre');
            content.textContent = text || emptyLabel;
            section.append(caption, content);
            return section;
        };
        pair.append(
            makeVersion('原文', change.originalText, '（新增）'),
            makeVersion('候选', change.candidateText, '（删除）'),
        );
        card.append(heading, pair);
        list.append(card);
    }
    host.append(toolbar, messages, list);
    updateAuditPresentation(panel);
    updateReviewSelectionPresentation(panel);
}

function initializeCandidateReview(panel, candidate, { acceptAll = false, preserveCandidate = false } = {}) {
    const session = state.session;
    session.proposalCandidate = candidate;
    session.reviewAudit = createCandidateAudit(session, candidate);
    session.acceptedChangeIds = new Set(session.reviewAudit.changes
        .filter(change => acceptAll || (change.classification !== 'protected'
            && !(session.generationIncomplete && change.kind === 'deleted')))
        .map(change => change.id));
    if (preserveCandidate) {
        session.candidate = candidate;
        session.audit = createCandidateAudit(session, candidate);
        renderAudit(panel);
    } else {
        composeReviewCandidate(panel);
        renderAudit(panel);
    }
    panel.querySelector('.story-rewriter-apply').disabled = !session.candidate.trim();
    panel.querySelector('.story-rewriter-replace').disabled = !session.candidate.trim();
}

function auditCurrentCandidate(panel, { rebuildReview = false } = {}) {
    const session = state.session;
    if (!session || session.scopeMode === 'selection' || !session.impactPlan) return;
    const candidate = panel.querySelector('.story-rewriter-candidate').value.trim();
    if (!candidate) {
        session.audit = null;
        updateAuditPresentation(panel);
        panel.querySelector('.story-rewriter-apply').disabled = true;
        panel.querySelector('.story-rewriter-replace').disabled = true;
        return;
    }
    if (rebuildReview) return initializeCandidateReview(panel, candidate, { acceptAll: true, preserveCandidate: true });
    session.audit = createCandidateAudit(session, candidate);
    renderAudit(panel);
    panel.querySelector('.story-rewriter-apply').disabled = false;
    panel.querySelector('.story-rewriter-replace').disabled = false;
}

function showCandidate(panel, candidate, instruction) {
    const session = state.session;
    session.requirements.push(instruction);
    if (session.requirements.length > MAX_SESSION_TURNS) session.requirements.shift();
    session.turns.push({
        instruction,
        candidate,
        impactPlan: cloneValue(session.impactPlan),
        generationIncomplete: session.generationIncomplete,
        generationIncompleteReason: session.generationIncompleteReason,
        generationSegments: session.generationSegments,
        createdAt: new Date().toISOString(),
    });
    if (session.turns.length > MAX_SESSION_TURNS) session.turns.shift();
    panel.querySelector('.story-rewriter-preview').hidden = false;
    panel.querySelector('.story-rewriter-generate').hidden = false;
    panel.querySelector('.story-rewriter-apply').disabled = false;
    panel.querySelector('.story-rewriter-replace').disabled = false;
    panel.querySelector('.story-rewriter-instruction').value = '';
    renderSessionTurns(panel);
    renderReferences(panel);
    session.reviewPlan = cloneValue(session.impactPlan);
    initializeCandidateReview(panel, candidate);
    switchWorkspaceView(panel, 'changes');
    const autoRejected = session.reviewAudit.changes.filter(change => change.classification === 'protected').length;
    const filteredNotice = autoRejected ? `已默认保留原文中的 ${autoRejected} 项疑似越界变化。` : '';
    const continuationNotice = session.generationSegments > 1 ? `已自动续接 ${session.generationSegments} 段。` : '';
    panel.querySelector('.story-rewriter-status').textContent = session.generationIncomplete
        ? `候选已保留，但未通过完整性检查。${continuationNotice}${session.generationIncompleteReason || '请检查文章结尾。'}你仍可编辑或确认应用。`
        : session.audit?.hardBlocked
            ? `候选已生成。${continuationNotice}${filteredNotice}合成稿仍有高风险项，请逐块确认；你仍可确认后应用。`
            : `候选已生成。${continuationNotice}${filteredNotice}可以逐块确认、继续提出要求，或应用为新版本。`;
}

function savePartialCheckpoint(session, candidate, segments, metadata = {}) {
    const text = String(candidate ?? '').trim();
    if (!text) return;
    if (text.length >= String(session.partialCandidate ?? '').length) {
        session.partialCandidate = text;
        session.partialSegments = segments;
    }
    generationLog('checkpoint', {
        ...metadata,
        segment: segments,
        responseCharacters: text.length,
    });
}

function describePartialRecovery(error) {
    if (isGenerationCancelled(error)) return '生成已取消，已保留取消前收到的正文。';
    if (isGenerationTimeout(error)) return `${error.message}已保留超时前收到的正文。`;
    return `后续生成中断：${error?.message ?? error}。已保留中断前收到的正文。`;
}

async function generateCompleteRevision(panel, instruction) {
    const session = state.session;
    const task = session.pendingTask;
    const effectivePlan = getEffectiveImpactPlan(session.impactPlan);
    setWorkspaceBusy(panel, true, '正在生成完整候选稿…', { cancelable: true });
    try {
        const limits = session.activeLimits ?? await getActiveGenerationLimits();
        session.activeLimits = limits;
        updateContextSummary(panel);
        const originalTokens = await countTokens(session.capture.messageText);
        const desiredResponseLength = desiredRevisionTokens(originalTokens);
        const revisionTask = {
            ...task,
            impactPlan: effectivePlan,
            previousCandidate: panel.querySelector('.story-rewriter-candidate').value.trim() || session.candidate,
            previousInstructions: session.requirements.slice(-MAX_SESSION_TURNS),
        };
        const maxContext = limits.maxContext;
        const singleResponseLimit = limits.maxResponse || desiredResponseLength;
        const runRevision = async initialPrompt => {
            let remainingBudget = desiredResponseLength;
            let prompt = initialPrompt;
            let assembled = '';
            let complete = false;
            let segments = 0;
            let stopReason = 'marker_missing';

            while (!complete && segments < MAX_REVISION_SEGMENTS && remainingBudget >= 256) {
                const promptTokens = await countTokens(prompt);
                const availableOutput = maxContext ? Math.floor(maxContext - promptTokens - 512) : remainingBudget;
                const minimumOutput = segments === 0 ? 512 : 256;
                const responseLength = Math.min(remainingBudget, availableOutput, singleResponseLimit);
                if (availableOutput < minimumOutput || responseLength < minimumOutput) {
                    if (!assembled) {
                        throw new Error(`完整候选请求至少需要 ${formatTokenCount(promptTokens + minimumOutput)} 上下文和 ${formatTokenCount(minimumOutput)} 单次响应空间。请检查当前预设上限，或缩短原文与资料。`);
                    }
                    stopReason = 'budget_exhausted';
                    break;
                }
                let parsed = { text: '', complete: false };
                for (let emptyAttempt = 0; emptyAttempt < 2; emptyAttempt++) {
                    const requestPrompt = emptyAttempt === 0 ? prompt : [
                        prompt,
                        '<empty_response_retry>',
                        '上一次响应没有任何可用正文，可能只生成了推理内容或空的结束标记。不要分析，不要说明原因；立即从正文第一个字符（续接时为下一个字符）开始输出，并在真正完成后追加结束标记。',
                        '</empty_response_retry>',
                    ].join('\n\n');
                    const raw = await generatePlain(requestPrompt, responseLength, session, {
                        segment: segments + 1,
                        attempt: emptyAttempt + 1,
                        promptTokens,
                    });
                    parsed = parseRevisionTextSegment(raw);
                    if (parsed.text || (parsed.complete && assembled)) break;
                    console.warn('[Story Rewriter] model returned no usable revision text', {
                        segment: segments + 1,
                        attempt: emptyAttempt + 1,
                        responseCharacters: raw.length,
                    });
                    if (emptyAttempt === 0) {
                        panel.querySelector('.story-rewriter-status').textContent = '模型首轮只返回了推理或空内容，正在自动重试正文…';
                    }
                }
                if (parsed.text) {
                    assembled = segments === 0
                        ? parsed.text.trim()
                        : mergeRevisionContinuation(assembled, parsed.text);
                }
                complete = parsed.complete;
                segments++;
                if (!assembled) throw new Error('模型连续两次只返回了推理或空内容。请检查当前预设的推理格式与最大响应 Token，或稍后重试。');
                savePartialCheckpoint(session, assembled, segments, { complete });
                if (complete) {
                    stopReason = 'completed';
                    break;
                }

                const usedTokens = await countTokens(assembled);
                remainingBudget = Math.max(0, desiredResponseLength - usedTokens);
                if (remainingBudget < 256) {
                    stopReason = 'budget_exhausted';
                    break;
                }
                panel.querySelector('.story-rewriter-status').textContent = `第 ${segments} 段未返回正文结束标记，正在请求第 ${segments + 1} 段…`;
                prompt = buildRevisionContinuationPrompt(revisionTask, assembled);
            }
            if (!complete && segments >= MAX_REVISION_SEGMENTS) stopReason = 'segment_limit';
            generationLog('revision_stop', {
                stage: '完整正文',
                segment: segments,
                responseCharacters: assembled.length,
                complete,
                stopReason,
            });
            return { assembled, complete, segments, stopReason };
        };

        let result = await runRevision(buildRevisionPrompt(revisionTask));
        let coverage = assessRevisionCompleteness(session.capture.messageText, result.assembled, effectivePlan);
        if (result.complete && !coverage.complete) {
            panel.querySelector('.story-rewriter-status').textContent = '模型只返回了局部片段，正在重新请求完整消息…';
            result = await runRevision(buildRevisionCoverageRepairPrompt(revisionTask, coverage));
            coverage = assessRevisionCompleteness(session.capture.messageText, result.assembled, effectivePlan);
        }
        if (!result.assembled) throw new Error('模型没有返回可用的完整候选正文。');
        if (state.session !== session || !panel.isConnected) return;
        if (session.cancelled) throw new GenerationCancelledError();
        session.generationIncomplete = !result.complete || !coverage.complete;
        session.generationIncompleteReason = !result.complete
            ? result.stopReason === 'segment_limit'
                ? `已达到最多 ${MAX_REVISION_SEGMENTS} 个续接分段，仍未收到正文结束标记。请检查文章结尾。`
                : result.stopReason === 'budget_exhausted'
                    ? '完整候选已用完本轮总预算，但未收到正文结束标记。请检查文章结尾。'
                    : '没有收到正文结束标记，模型可能已结束，也可能仍被截断。请检查文章结尾。'
            : !coverage.complete
                ? `候选只有原文约 ${Math.round(coverage.lengthRatio * 100)}%，不足以覆盖应保留内容。请检查全文。`
                : '';
        session.generationSegments = result.segments;
        showCandidate(panel, result.assembled, instruction);
        session.pendingTask = null;
        session.pendingInstruction = '';
    } catch (error) {
        console.error('[Story Rewriter] complete revision failed', error);
        const partial = String(session.partialCandidate ?? '').trim();
        if (partial && state.session === session && panel.isConnected) {
            session.generationIncomplete = true;
            session.generationIncompleteReason = describePartialRecovery(error);
            session.generationSegments = session.partialSegments;
            showCandidate(panel, partial, instruction);
            session.pendingTask = null;
            session.pendingInstruction = '';
        } else if (panel.isConnected) {
            panel.querySelector('.story-rewriter-status').textContent = isGenerationCancelled(error)
                ? '已取消本次生成；取消前尚未收到可保留的正文。'
                : `生成失败：${error.message ?? error}`;
        }
    } finally {
        session.generationInProgress = false;
        if (panel.isConnected && state.panel === panel) {
            setWorkspaceBusy(panel, false, panel.querySelector('.story-rewriter-status').textContent);
        }
    }
}

async function generateSemanticCandidate(panel) {
    const session = state.session;
    const instructionInput = panel.querySelector('.story-rewriter-instruction');
    const instruction = instructionInput.value.trim();
    if (!instruction) {
        panel.querySelector('.story-rewriter-status').textContent = '请先输入本轮修改要求。';
        return;
    }
    if (!captureIsCurrent(session?.capture)) {
        panel.querySelector('.story-rewriter-status').textContent = '原消息、聊天或 Swipe 已变化，请重新打开工作台。';
        return;
    }
    startGenerationSession(session);
    session.influence = session.scopeMode === 'selection' ? 'strict' : 'semantic';
    const constraints = panel.querySelector('.story-rewriter-constraints').value.trim();
    const fellBack = applyAutomaticContextFallback(panel);
    setWorkspaceBusy(panel, true, fellBack ? '完整上下文接口不可用，已降级并建立故事资料视图…' : '正在建立故事资料视图…', { cancelable: true });
    try {
        const limits = await syncContextSummary(panel);
        const paragraphs = segmentMessage(session.capture.messageText);
        const focusIds = session.editMode === 'full'
            ? []
            : getFocusParagraphIds(paragraphs, session.capture.range, session.editMode);
        if (session.editMode !== 'full' && !focusIds.length) throw new Error('无法把选区映射到原文段落。');
        const repository = await buildSemanticRepository(session, instruction, constraints);
        if (session.cancelled) throw new GenerationCancelledError();
        session.repository = repository;
        panel.querySelector('.story-rewriter-status').textContent = `找到 ${repository.retrieval.items.length} 条相关资料，正在识别影响范围…`;
        const mandatoryReferences = [{
            id: 'user-current-instruction',
            sourceType: 'instruction',
            sourceLabel: '用户本轮修改要求',
            text: instruction,
            authority: 'user-rule',
        }];
        if (constraints) {
            mandatoryReferences.push({
                id: 'user-session-constraints',
                sourceType: 'instruction',
                sourceLabel: '本次编辑持续约束',
                text: constraints,
                authority: 'user-rule',
            });
        }
        const task = {
            editMode: session.editMode,
            influence: session.influence,
            instruction,
            constraints,
            originalMessage: session.capture.messageText,
            selectedText: focusIds.length ? compactSelectedText(session.capture.selectedText) : '',
            paragraphs,
            focusIds,
            references: [...mandatoryReferences, ...repository.retrieval.items],
        };
        const impactPrompt = buildImpactPrompt(task);
        const promptTokens = await countTokens(impactPrompt);
        const maxContext = limits.maxContext;
        const availableAnalysisOutput = maxContext ? Math.floor(maxContext - promptTokens - 256) : state.settings.analysisResponseLength;
        let rawPlan;
        let fallbackReason = '';
        if (availableAnalysisOutput < 512) {
            fallbackReason = `影响分析请求约需 ${formatTokenCount(promptTokens + 256)}，当前可用上下文不足。`;
            rawPlan = createConservativeImpactPlan(paragraphs, focusIds, instruction, session.editMode);
        } else {
            try {
                rawPlan = await generateStructured(
                    impactPrompt,
                    IMPACT_JSON_SCHEMA,
                    Math.min(state.settings.analysisResponseLength, availableAnalysisOutput, limits.maxResponse || Number.POSITIVE_INFINITY),
                    parseImpactResponse,
                    session,
                    '影响分析',
                );
            } catch (error) {
                if (isGenerationCancelled(error)) throw error;
                fallbackReason = String(error?.message ?? error);
                console.warn('[Story Rewriter] structured impact analysis unavailable; using conservative local plan', error);
                rawPlan = createConservativeImpactPlan(paragraphs, focusIds, instruction, session.editMode);
            }
        }
        let plan = validateImpactPlan(rawPlan, paragraphs, focusIds, task.references.map(item => item.id));
        plan.fallback = Boolean(rawPlan.fallback);
        plan.fallbackReason = fallbackReason;
        if (session.influence === 'strict') {
            plan = constrainImpactPlan(plan, paragraphs, { maxLinked: 4, maxTransition: 2 });
        }
        session.impactPlan = plan;
        session.pendingTask = task;
        session.pendingInstruction = instruction;
        renderImpactPlan(panel);
        renderReferences(panel);
        if (plan.fallback) {
            panel.querySelector('.story-rewriter-status').textContent = `已使用本地保守范围继续生成；请在逐块确认中检查。${fallbackReason ? ` 原因：${fallbackReason}` : ''}`;
        }
    } catch (error) {
        console.error('[Story Rewriter] impact analysis failed', error);
        session.generationInProgress = false;
        panel.querySelector('.story-rewriter-status').textContent = isGenerationCancelled(error)
            ? '已取消本次生成。'
            : `分析失败：${error.message ?? error}`;
        return;
    } finally {
        if (panel.isConnected && state.panel === panel) {
            setWorkspaceBusy(panel, false, panel.querySelector('.story-rewriter-status').textContent);
        }
    }
    await generateCompleteRevision(panel, instruction);
}

async function generateCandidate(panel) {
    if (state.session?.scopeMode === 'selection') return generatePreciseCandidate(panel);
    return generateSemanticCandidate(panel);
}

function getHistory(message) {
    if (state.settings.persistentUndo) {
        message.extra ??= {};
        if (!Array.isArray(message.extra[HISTORY_KEY])) message.extra[HISTORY_KEY] = [];
        return message.extra[HISTORY_KEY];
    }
    if (!state.sessionHistory.has(message)) state.sessionHistory.set(message, []);
    return state.sessionHistory.get(message);
}

function updateHistory(message, history) {
    if (state.settings.persistentUndo) {
        message.extra ??= {};
        if (history.length) message.extra[HISTORY_KEY] = history;
        else delete message.extra[HISTORY_KEY];
    } else {
        state.sessionHistory.set(message, history);
    }
}

async function persistMessageText(message, nextText, previousText) {
    refreshContext();
    const messageId = state.context.chat.indexOf(message);
    if (messageId < 0) throw new Error('目标消息已不在当前聊天中。');
    const hadSwipe = Array.isArray(message.swipes) && Number.isInteger(message.swipe_id);
    const previousSwipe = hadSwipe ? message.swipes[message.swipe_id] : undefined;
    const hadDisplayText = Object.hasOwn(message.extra ?? {}, 'display_text');
    const previousDisplayText = message.extra?.display_text;
    const previousTainted = state.context.chatMetadata?.tainted;

    message.mes = nextText;
    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
        message.swipes[message.swipe_id] = nextText;
    }
    if (message.extra?.display_text === previousText) message.extra.display_text = nextText;
    if (state.context.chatMetadata) state.context.chatMetadata.tainted = true;

    try {
        const editedEvent = state.context.eventTypes?.MESSAGE_EDITED;
        if (editedEvent) await state.context.eventSource.emit(editedEvent, messageId);
        state.context.updateMessageBlock(messageId, message);
        const updatedEvent = state.context.eventTypes?.MESSAGE_UPDATED;
        if (updatedEvent) await state.context.eventSource.emit(updatedEvent, messageId);
        await state.context.saveChat();
        ensureMessageButtons();
    } catch (error) {
        message.mes = previousText;
        if (hadSwipe) message.swipes[message.swipe_id] = previousSwipe;
        if (message.extra) {
            if (hadDisplayText) message.extra.display_text = previousDisplayText;
            else delete message.extra.display_text;
        }
        if (state.context.chatMetadata) state.context.chatMetadata.tainted = previousTainted;
        state.context.updateMessageBlock(messageId, message);
        throw error;
    }
}

function createRevisionMetadata(session, audit) {
    const plan = session.reviewPlan ?? session.impactPlan;
    return {
        version: 1,
        mode: session.editMode,
        scope: session.scopeMode,
        originalHash: session.capture.messageHash,
        instruction: session.requirements.at(-1) ?? session.pendingInstruction ?? '',
        requirements: session.requirements.slice(-MAX_SESSION_TURNS),
        influence: session.influence,
        impact: {
            focus: plan?.focusRegions?.map(region => region.paragraphId) ?? [],
            linked: plan?.linkedRegions?.filter(region => region.enabled !== false).map(region => region.paragraphId) ?? [],
            transition: plan?.transitionRegions?.filter(region => region.enabled !== false).map(region => region.paragraphId) ?? [],
        },
        audit: audit ? {
            counts: audit.counts,
            warnings: audit.warnings,
            conflicts: audit.conflicts,
        } : null,
        createdAt: new Date().toISOString(),
    };
}

async function persistAsNewSwipe(message, nextText, session) {
    refreshContext();
    const messageId = state.context.chat.indexOf(message);
    if (messageId < 0) throw new Error('目标消息已不在当前聊天中。');
    const snapshot = {
        mes: message.mes,
        extra: cloneValue(message.extra ?? {}),
        swipes: cloneValue(message.swipes ?? null),
        swipeInfo: cloneValue(message.swipe_info ?? null),
        swipeId: message.swipe_id,
        tainted: state.context.chatMetadata?.tainted,
    };

    try {
        appendRevisionSwipe(message, nextText, createRevisionMetadata(session, session.audit));
        if (state.context.chatMetadata) state.context.chatMetadata.tainted = true;

        state.context.updateMessageBlock(messageId, message);
        state.context.swipe?.refresh?.();
        const swipedEvent = state.context.eventTypes?.MESSAGE_SWIPED;
        if (swipedEvent) await state.context.eventSource.emit(swipedEvent, messageId);
        const updatedEvent = state.context.eventTypes?.MESSAGE_UPDATED;
        if (updatedEvent) await state.context.eventSource.emit(updatedEvent, messageId);
        await state.context.saveChat();
        ensureMessageButtons();
    } catch (error) {
        message.mes = snapshot.mes;
        message.extra = snapshot.extra;
        if (snapshot.swipes === null) delete message.swipes;
        else message.swipes = snapshot.swipes;
        if (snapshot.swipeInfo === null) delete message.swipe_info;
        else message.swipe_info = snapshot.swipeInfo;
        if (snapshot.swipeId === undefined) delete message.swipe_id;
        else message.swipe_id = snapshot.swipeId;
        if (state.context.chatMetadata) state.context.chatMetadata.tainted = snapshot.tainted;
        state.context.updateMessageBlock(messageId, message);
        state.context.swipe?.refresh?.();
        throw error;
    }
}

function confirmAuditRisks(session, actionLabel) {
    const audit = session.audit;
    if (!audit?.hardBlocked && !audit?.requiresOverride) return true;
    const messages = [...(audit.conflicts ?? []), ...(audit.warnings ?? [])];
    const visibleMessages = messages.slice(0, 6).map(message => `• ${String(message).slice(0, 180)}`);
    if (messages.length > visibleMessages.length) visibleMessages.push(`• 另有 ${messages.length - visibleMessages.length} 项，请在“逐块确认”中检查。`);
    const severity = audit.hardBlocked ? '审计发现高风险项' : '审计发现需要确认的提醒';
    return globalThis.confirm?.([
        `${severity}：`,
        '',
        ...visibleMessages,
        '',
        '审计仅提供风险提示，最终决定权属于你。',
        `确认${actionLabel}吗？`,
    ].join('\n')) ?? false;
}

async function saveSemanticCandidateAsSwipe(panel) {
    const session = state.session;
    const candidate = panel.querySelector('.story-rewriter-candidate').value.trim();
    if (!candidate) return notify('候选内容不能为空。', 'warning');
    if (!captureIsCurrent(session?.capture)) return notify('原消息、聊天或 Swipe 已变化，未执行保存。', 'warning');
    auditCurrentCandidate(panel);
    if (!confirmAuditRisks(session, '应用为新版本')) return;

    setWorkspaceBusy(panel, true, '正在应用为新版本…');
    try {
        await persistAsNewSwipe(session.capture.message, candidate, session);
        closeWorkspace();
        notify('已应用为新版本，原回复仍然保留。', 'success');
    } catch (error) {
        notify(`保存失败：${error.message ?? error}`, 'error');
        if (panel.isConnected && state.panel === panel) setWorkspaceBusy(panel, false, `保存失败：${error.message ?? error}`);
    }
}

async function savePreciseCandidateAsSwipe(panel) {
    const session = state.session;
    const candidate = panel.querySelector('.story-rewriter-candidate').value.trim();
    if (!candidate) return notify('候选内容不能为空。', 'warning');
    if (!captureIsCurrent(session?.capture)) return notify('原消息、聊天或 Swipe 已变化，未执行保存。', 'warning');

    const nextText = replaceRange(session.capture.messageText, session.capture.range, candidate);
    setWorkspaceBusy(panel, true, '正在保存为新版本…');
    try {
        await persistAsNewSwipe(session.capture.message, nextText, session);
        closeWorkspace();
        notify('已应用为新版本，原回复仍然保留。', 'success');
    } catch (error) {
        notify(`保存失败：${error.message ?? error}`, 'error');
        if (panel.isConnected && state.panel === panel) setWorkspaceBusy(panel, false, `保存失败：${error.message ?? error}`);
    }
}

async function replaceWithSemanticCandidate(panel) {
    const session = state.session;
    const candidate = panel.querySelector('.story-rewriter-candidate').value.trim();
    if (!candidate) return notify('候选内容不能为空。', 'warning');
    if (!captureIsCurrent(session?.capture)) return notify('原消息、聊天或 Swipe 已变化，未执行替换。', 'warning');
    auditCurrentCandidate(panel);
    const hasAuditRisks = Boolean(session.audit?.hardBlocked || session.audit?.requiresOverride);
    if (hasAuditRisks) {
        if (!confirmAuditRisks(session, '直接覆盖当前 Swipe')) return;
    } else if (!(globalThis.confirm?.('这会替换当前 Swipe 的完整消息。确认继续吗？') ?? false)) return;

    const previousText = session.capture.messageText;
    const history = getHistory(session.capture.message);
    const previousHistory = history.slice();
    history.push({
        start: 0,
        before: previousText,
        after: candidate,
        instruction: session.requirements.join('\n'),
        constraints: panel.querySelector('.story-rewriter-constraints').value.trim(),
        contextMode: session.contextMode,
        editMode: session.editMode,
        createdAt: new Date().toISOString(),
    });
    while (history.length > MAX_HISTORY) history.shift();
    updateHistory(session.capture.message, history);

    setWorkspaceBusy(panel, true, '正在替换当前 Swipe…');
    try {
        await persistMessageText(session.capture.message, candidate, previousText);
        closeWorkspace();
        showUndoSnackbar(session.capture.message, '已替换当前完整消息');
        notify('已替换当前 Swipe 的完整消息。', 'success');
    } catch (error) {
        history.splice(0, history.length, ...previousHistory);
        updateHistory(session.capture.message, history);
        notify(`替换失败：${error.message ?? error}`, 'error');
        if (panel.isConnected && state.panel === panel) setWorkspaceBusy(panel, false, `替换失败：${error.message ?? error}`);
    }
}

async function applyCandidate(panel) {
    if (state.session?.scopeMode === 'selection') return savePreciseCandidateAsSwipe(panel);
    return saveSemanticCandidateAsSwipe(panel);
}

function switchWorkspaceView(panel, view) {
    panel.querySelectorAll('.story-rewriter-view-tab').forEach(button => {
        button.classList.toggle('is-active', button.dataset.view === view);
    });
    panel.querySelectorAll('.story-rewriter-view').forEach(section => {
        section.hidden = section.dataset.view !== view;
    });
}

function openRewriteWorkspace(editMode = 'semantic', captureOverride = null) {
    refreshContext();
    const sourceCapture = captureOverride ?? state.capture;
    if (!sourceCapture || !EDIT_MODES.has(editMode)) return;
    closeWorkspace();
    hideActionButton();
    const capture = {
        ...sourceCapture,
        range: { ...sourceCapture.range },
        chatId: state.context.chatId,
        swipeId: sourceCapture.message.swipe_id ?? null,
        messageHash: hashText(sourceCapture.messageText),
    };
    const hasSelection = editMode !== 'full' && !captureOverride;
    const titles = {
        semantic: hasSelection ? '修改选中内容' : '修改这条回复',
        full: '修改这条回复',
    };
    state.session = {
        capture,
        editMode,
        scopeMode: 'smart',
        contextMode: state.settings.contextMode,
        influence: 'semantic',
        constraints: '',
        requirements: [],
        candidate: '',
        proposalCandidate: '',
        reviewAudit: null,
        acceptedChangeIds: new Set(),
        turns: [],
        repository: null,
        impactPlan: null,
        reviewPlan: null,
        audit: null,
        pendingTask: null,
        pendingInstruction: '',
        cancelled: false,
        generationInProgress: false,
        generationController: null,
        activeLimits: null,
        generationIncomplete: false,
        generationIncompleteReason: '',
        generationSegments: 0,
        partialCandidate: '',
        partialSegments: 0,
        generationDiagnostics: [],
    };

    const semantic = true;
    const panel = document.createElement('aside');
    panel.id = 'story-rewriter-panel';
    panel.className = 'story-rewriter-ui story-rewriter-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'story-rewriter-title');
    panel.innerHTML = `
        <div class="story-rewriter-resize-handle" title="拖动调整工作台宽度" aria-hidden="true"></div>
        <header class="story-rewriter-panel-header">
            <div><h3 id="story-rewriter-title">${titles[editMode]}</h3><small>消息 #${capture.messageId} · ${hasSelection ? '从选区开始' : '自动识别修改重点'}</small></div>
            <button type="button" class="story-rewriter-close" aria-label="关闭">×</button>
        </header>
        <div class="story-rewriter-panel-body">
            <section class="story-rewriter-context-card">
                <strong>${hasSelection ? '修改范围' : '修改方式'}</strong>
                ${hasSelection ? `
                    <label class="story-rewriter-scope-option"><input type="radio" name="story-rewriter-scope" value="smart" checked><span><b>智能关联调整</b><small>允许同步调整相关伏笔、因果和必要衔接。</small></span></label>
                    <label class="story-rewriter-scope-option"><input type="radio" name="story-rewriter-scope" value="selection"><span><b>仅改选区</b><small>圈外文字保持不变。</small></span></label>` : '<small>Agent 会根据你的要求识别需要调整的段落，其他内容尽量保持不变。</small>'}
                <small class="story-rewriter-context-summary"></small>
                <small class="story-rewriter-timeline-notice">目标是历史消息；会参考它之后的现有剧情，以减少前后冲突。</small>
            </section>

            <details class="story-rewriter-source-details">
                <summary>${hasSelection ? '当前选区' : '当前完整消息'}</summary>
                <textarea class="text_pole story-rewriter-original" rows="6" readonly></textarea>
            </details>

            <details class="story-rewriter-constraints-details">
                <summary>必须保留（可选）</summary>
                <textarea id="story-rewriter-constraints" class="text_pole story-rewriter-constraints" rows="3" placeholder="例如：玛修的身份、性格和其他人物路线保持不变。"></textarea>
            </details>

            <div class="story-rewriter-turns" aria-label="本次编辑历史" hidden></div>

            <section class="story-rewriter-preview" hidden>
                <h4>新版本</h4>
                <div class="story-rewriter-view-tabs" ${semantic ? '' : 'hidden'}>
                    <button type="button" class="story-rewriter-view-tab" data-view="changes">逐块确认</button>
                    <button type="button" class="story-rewriter-view-tab is-active" data-view="full">新版本</button>
                    <button type="button" class="story-rewriter-view-tab" data-view="sources">使用的资料</button>
                </div>
                <div class="story-rewriter-audit-summary"></div>
                <section class="story-rewriter-view story-rewriter-diff" data-view="changes" hidden>
                    <details class="story-rewriter-impact" hidden>
                        <summary>Agent 识别的影响范围</summary>
                        <div class="story-rewriter-impact-content"></div>
                    </details>
                    <div class="story-rewriter-diff-content"></div>
                </section>
                <section class="story-rewriter-view" data-view="full">
                    <label for="story-rewriter-candidate">合成后的完整版本（可编辑）</label>
                    <textarea id="story-rewriter-candidate" class="text_pole story-rewriter-candidate" rows="24"></textarea>
                </section>
                <section class="story-rewriter-view story-rewriter-sources" data-view="sources" hidden></section>
            </section>
        </div>
        <footer class="story-rewriter-panel-footer">
            <label for="story-rewriter-instruction">本轮修改要求</label>
            <textarea id="story-rewriter-instruction" class="text_pole story-rewriter-instruction" rows="3" placeholder="${semantic ? '例如：这里面的贞德线重新规划一下，其他人物设定保持不变。' : '第一次可以说明完整目标；之后可输入“再克制一点”等继续调整。'}"></textarea>
            <div class="story-rewriter-actions">
                <button type="button" class="menu_button story-rewriter-cancel" hidden>取消生成</button>
                <button type="button" class="menu_button story-rewriter-generate">生成新版本</button>
                <button type="button" class="menu_button story-rewriter-apply" disabled>应用为新版本</button>
            </div>
            <details class="story-rewriter-advanced-actions">
                <summary>高级操作</summary>
                <button type="button" class="menu_button story-rewriter-replace" disabled>覆盖当前版本</button>
                <small>危险操作：直接替换当前 Swipe 的完整消息。</small>
            </details>
            <div class="story-rewriter-status" role="status" aria-live="polite">会使用酒馆完整上下文，先识别影响范围，再生成新版本。</div>
        </footer>`;

    panel.querySelector('.story-rewriter-original').value = hasSelection ? capture.range.rawText : capture.messageText;
    panel.querySelectorAll('input[name="story-rewriter-scope"]').forEach(input => {
        input.addEventListener('change', event => {
            if (!event.currentTarget.checked) return;
            state.session.scopeMode = SCOPE_MODES.has(event.currentTarget.value) ? event.currentTarget.value : 'smart';
            resetSessionForScopeChange(panel);
            panel.querySelector('.story-rewriter-status').textContent = state.session.scopeMode === 'selection'
                ? '只会生成选区的替换文字，圈外内容保持不变。'
                : '会识别相关段落并生成完整新版本。';
            updateScopeInterface(panel);
        });
    });
    panel.querySelector('.story-rewriter-close').addEventListener('click', closeWorkspace);
    panel.querySelector('.story-rewriter-cancel').addEventListener('click', () => {
        if (!state.session) return;
        cancelGenerationSession(state.session);
        panel.querySelector('.story-rewriter-status').textContent = '正在取消本次生成…';
    });
    panel.querySelector('.story-rewriter-generate').addEventListener('click', () => generateCandidate(panel));
    panel.querySelector('.story-rewriter-apply').addEventListener('click', () => applyCandidate(panel));
    panel.querySelector('.story-rewriter-replace').addEventListener('click', () => replaceWithSemanticCandidate(panel));
    panel.querySelector('.story-rewriter-candidate').addEventListener('input', event => {
        state.session.candidate = event.currentTarget.value;
        if (state.session.scopeMode === 'selection') {
            panel.querySelector('.story-rewriter-apply').disabled = !event.currentTarget.value.trim();
        } else {
            state.session.generationIncomplete = false;
            state.session.generationIncompleteReason = '';
            state.session.generationSegments = 0;
            auditCurrentCandidate(panel, { rebuildReview: true });
        }
    });
    panel.querySelector('.story-rewriter-instruction').addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void generateCandidate(panel);
        }
    });
    panel.querySelectorAll('.story-rewriter-view-tab').forEach(button => {
        button.addEventListener('click', () => switchWorkspaceView(panel, button.dataset.view));
    });
    document.body.append(panel);
    state.panel = panel;
    enablePanelResize(panel);
    updateContextSummary(panel);
    void syncContextSummary(panel);
    updateScopeInterface(panel);
    panel.querySelector('.story-rewriter-instruction').focus();
}

function openFullRewriteWorkspace(messageId) {
    refreshContext();
    const message = state.context.chat?.[messageId];
    if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') return;
    const capture = {
        message,
        messageId,
        messageText: message.mes,
        selectedText: message.mes,
        range: { start: 0, end: message.mes.length, rawText: message.mes },
    };
    openRewriteWorkspace('full', capture);
}

function findUndoStart(text, entry) {
    if (text.slice(entry.start, entry.start + entry.after.length) === entry.after) return entry.start;
    const first = text.indexOf(entry.after);
    return first !== -1 && first === text.lastIndexOf(entry.after) ? first : -1;
}

async function undoMessage(message) {
    const history = getHistory(message);
    if (!history.length) return notify('没有可撤销的局部改写。', 'warning');
    const entry = history[history.length - 1];
    const start = findUndoStart(message.mes, entry);
    if (start < 0) return notify('消息已被其他编辑改变，无法安全撤销。', 'warning');
    const previousText = message.mes;
    const nextText = `${previousText.slice(0, start)}${entry.before}${previousText.slice(start + entry.after.length)}`;
    history.pop();
    updateHistory(message, history);
    try {
        await persistMessageText(message, nextText, previousText);
        state.snackbar?.remove();
        state.snackbar = null;
        notify('已撤销上一次局部改写。', 'success');
    } catch (error) {
        history.push(entry);
        updateHistory(message, history);
        ensureMessageButtons();
        notify(`撤销失败：${error.message ?? error}`, 'error');
    }
}

function showUndoSnackbar(message, label = '已完成局部替换') {
    state.snackbar?.remove();
    const snackbar = document.createElement('div');
    snackbar.className = 'story-rewriter-ui story-rewriter-snackbar';
    const text = document.createElement('span');
    text.textContent = label;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '撤销';
    snackbar.append(text, button);
    button.addEventListener('click', () => undoMessage(message));
    document.body.append(snackbar);
    state.snackbar = snackbar;
    window.setTimeout(() => {
        if (state.snackbar === snackbar) {
            snackbar.remove();
            state.snackbar = null;
        }
    }, 8000);
}

function ensureMessageButtons() {
    if (!state.active) return;
    refreshContext();
    for (const element of document.querySelectorAll('.mes')) {
        const messageId = Number(element.getAttribute('mesid'));
        const message = state.context.chat?.[messageId];
        const existingUndo = element.querySelector('.story-rewriter-undo');
        const existingFull = element.querySelector('.story-rewriter-full');
        const eligible = message && !message.is_user && !message.is_system && typeof message.mes === 'string';
        const host = element.querySelector('.mes_buttons');
        if (!eligible || !state.settings.enabled || !host) {
            existingFull?.remove();
        } else if (!existingFull) {
            const button = document.createElement('div');
            button.className = 'mes_button story-rewriter-full fa-solid fa-wand-magic-sparkles interactable';
            button.title = '修改这条回复';
            button.setAttribute('role', 'button');
            button.setAttribute('tabindex', '0');
            host.insertBefore(button, host.querySelector('.mes_edit'));
        }
        const history = state.settings.persistentUndo && message && !message.is_user && !message.is_system
            ? message.extra?.[HISTORY_KEY]
            : null;
        if (!Array.isArray(history) || !history.length) {
            existingUndo?.remove();
            continue;
        }
        if (existingUndo) continue;
        if (!host) continue;
        const button = document.createElement('div');
        button.className = 'mes_button story-rewriter-undo fa-solid fa-rotate-left interactable';
        button.title = '撤销上一次改写';
        button.setAttribute('role', 'button');
        button.setAttribute('tabindex', '0');
        host.insertBefore(button, host.querySelector('.mes_edit'));
    }
}

function queueUndoButtonRefresh() {
    if (state.observerQueued) return;
    state.observerQueued = true;
    queueMicrotask(() => {
        state.observerQueued = false;
        ensureMessageButtons();
    });
}

function onDocumentClick(event) {
    const fullButton = event.target.closest?.('.story-rewriter-full');
    if (fullButton) {
        event.preventDefault();
        event.stopPropagation();
        const messageId = Number(fullButton.closest('.mes')?.getAttribute('mesid'));
        if (Number.isInteger(messageId)) openFullRewriteWorkspace(messageId);
        return;
    }
    const undoButton = event.target.closest?.('.story-rewriter-undo');
    if (!undoButton) return;
    event.preventDefault();
    event.stopPropagation();
    const messageId = Number(undoButton.closest('.mes')?.getAttribute('mesid'));
    const message = state.context.chat?.[messageId];
    if (message) void undoMessage(message);
}

function onKeyDown(event) {
    const messageButton = event.target.closest?.('.story-rewriter-full, .story-rewriter-undo');
    if (messageButton && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        messageButton.click();
        return;
    }
    if (event.key === 'Escape' && state.panel && state.panel.dataset.busy !== 'true') closeWorkspace();
}

export async function activate() {
    if (state.active) return;
    state.context = globalThis.SillyTavern?.getContext?.();
    if (!state.context) throw new Error('SillyTavern.getContext() is unavailable.');
    state.active = true;
    loadSettings();
    await mountSettings();
    createActionButton();
    document.addEventListener('pointerdown', onSelectionPointerDown, true);
    window.addEventListener('pointerup', onSelectionPointerUp, true);
    window.addEventListener('pointercancel', onSelectionPointerUp, true);
    window.addEventListener('mouseup', onSelectionPointerUp, true);
    window.addEventListener('touchend', onSelectionPointerUp, true);
    window.addEventListener('touchcancel', onSelectionPointerUp, true);
    document.addEventListener('contextmenu', onSelectionPointerUp, true);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keyup', onSelectionKeyUp);
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onViewportResize);
    document.addEventListener('scroll', onViewportScroll, true);
    state.observer = new MutationObserver(queueUndoButtonRefresh);
    state.observer.observe(document.querySelector('#chat') ?? document.body, { childList: true, subtree: true });
    ensureMessageButtons();
    console.info('[Story Rewriter] activated');
}

export function deactivate() {
    if (!state.active) return;
    state.active = false;
    document.removeEventListener('pointerdown', onSelectionPointerDown, true);
    window.removeEventListener('pointerup', onSelectionPointerUp, true);
    window.removeEventListener('pointercancel', onSelectionPointerUp, true);
    window.removeEventListener('mouseup', onSelectionPointerUp, true);
    window.removeEventListener('touchend', onSelectionPointerUp, true);
    window.removeEventListener('touchcancel', onSelectionPointerUp, true);
    document.removeEventListener('contextmenu', onSelectionPointerUp, true);
    window.removeEventListener('blur', onWindowBlur);
    document.removeEventListener('selectionchange', onSelectionChange);
    document.removeEventListener('keyup', onSelectionKeyUp);
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onViewportResize);
    document.removeEventListener('scroll', onViewportScroll, true);
    window.clearTimeout(state.selectionCaptureTimer);
    state.selectionCaptureTimer = null;
    state.selectionPointerDown = false;
    state.observer?.disconnect();
    state.observer = null;
    state.actionButton?.remove();
    state.actionButton = null;
    closeWorkspace();
    state.snackbar?.remove();
    state.snackbar = null;
    document.querySelector('#story_rewriter_settings')?.remove();
    document.querySelectorAll('.story-rewriter-undo, .story-rewriter-full').forEach(element => element.remove());
}
