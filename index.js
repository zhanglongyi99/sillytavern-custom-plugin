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
    auditRevision,
    buildImpactPrompt,
    buildRevisionPrompt,
    compactSelectedText,
    createCharacterChunks,
    createChatChunks,
    createWorldInfoChunks,
    estimateTokenCount,
    getFocusParagraphIds,
    IMPACT_JSON_SCHEMA,
    IMPACT_LEVELS,
    parseImpactResponse,
    parseRevisionResponse,
    retrieveReferences,
    REVISION_JSON_SCHEMA,
    segmentMessage,
    validateImpactPlan,
} from './lib/semantic.js';
import { appendRevisionSwipe } from './lib/swipe.js';

const EXTENSION_KEY = 'story_rewriter';
const HISTORY_KEY = 'story_rewriter_history';
const MAX_HISTORY = 5;
const MAX_SESSION_TURNS = 8;
const CONTEXT_MODES = new Set(['tavern', 'local']);
const EDIT_MODES = new Set(['semantic', 'full']);
const SCOPE_MODES = new Set(['selection', 'smart']);
const DEFAULT_SETTINGS = Object.freeze({
    settingsVersion: 5,
    enabled: true,
    contextMode: 'tavern',
    contextCharacters: 2000,
    responseLength: 1024,
    fullResponseLength: 8192,
    persistentUndo: true,
    defaultInfluence: 'semantic',
    confirmImpact: false,
    retrievalCharacters: 12000,
    retrievalResults: 18,
    analysisResponseLength: 4096,
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
    sessionHistory: new WeakMap(),
};

let tavernRuntimePromise = null;

function refreshContext() {
    const context = globalThis.SillyTavern?.getContext?.();
    if (context) state.context = context;
    return state.context;
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

function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function loadSettings() {
    const stored = state.context.extensionSettings?.[EXTENSION_KEY] ?? {};
    const storedVersion = Number(stored.settingsVersion ?? 0);
    const upgradingToV4 = storedVersion < 4;
    const upgradingToV5 = storedVersion < 5;
    const storedAnalysisLength = Number(stored.analysisResponseLength);
    state.settings = {
        ...DEFAULT_SETTINGS,
        ...stored,
        settingsVersion: 5,
        enabled: stored.enabled ?? DEFAULT_SETTINGS.enabled,
        contextMode: upgradingToV4
            ? DEFAULT_SETTINGS.contextMode
            : CONTEXT_MODES.has(stored.contextMode) ? stored.contextMode : DEFAULT_SETTINGS.contextMode,
        contextCharacters: clampNumber(stored.contextCharacters, 0, 8000, DEFAULT_SETTINGS.contextCharacters),
        responseLength: clampNumber(stored.responseLength, 64, 4096, DEFAULT_SETTINGS.responseLength),
        fullResponseLength: clampNumber(stored.fullResponseLength, 512, 16384, DEFAULT_SETTINGS.fullResponseLength),
        persistentUndo: stored.persistentUndo ?? DEFAULT_SETTINGS.persistentUndo,
        defaultInfluence: IMPACT_LEVELS.includes(stored.defaultInfluence) ? stored.defaultInfluence : DEFAULT_SETTINGS.defaultInfluence,
        confirmImpact: stored.confirmImpact ?? DEFAULT_SETTINGS.confirmImpact,
        retrievalCharacters: clampNumber(stored.retrievalCharacters, 1000, 50000, DEFAULT_SETTINGS.retrievalCharacters),
        retrievalResults: clampNumber(stored.retrievalResults, 3, 40, DEFAULT_SETTINGS.retrievalResults),
        analysisResponseLength: upgradingToV5 && (!Number.isFinite(storedAnalysisLength) || storedAnalysisLength <= 1400)
            ? DEFAULT_SETTINGS.analysisResponseLength
            : clampNumber(storedAnalysisLength, 512, 4096, DEFAULT_SETTINGS.analysisResponseLength),
    };
    state.context.extensionSettings[EXTENSION_KEY] = state.settings;
    if (upgradingToV4 || upgradingToV5) state.context.saveSettingsDebounced();
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
    enabled.checked = state.settings.enabled;
    contextMode.value = state.settings.contextMode;
    contextCharacters.value = String(state.settings.contextCharacters);
    responseLength.value = String(state.settings.responseLength);
    fullResponseLength.value = String(state.settings.fullResponseLength);
    persistentUndo.checked = state.settings.persistentUndo;
    retrievalCharacters.value = String(state.settings.retrievalCharacters);
    retrievalResults.value = String(state.settings.retrievalResults);
    analysisResponseLength.value = String(state.settings.analysisResponseLength);

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
        state.settings.fullResponseLength = clampNumber(fullResponseLength.value, 512, 16384, DEFAULT_SETTINGS.fullResponseLength);
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
    state.panel?.remove();
    state.panel = null;
    state.session = null;
    hideActionButton();
}

function setWorkspaceBusy(panel, busy, status = '') {
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
        if (candidate && apply) apply.disabled = !candidate.value.trim() || Boolean(state.session?.audit?.hardBlocked);
        panel.querySelector('.story-rewriter-replace')?.toggleAttribute('disabled', !candidate?.value.trim() || Boolean(state.session?.audit?.hardBlocked));
    }
    panel.querySelector('.story-rewriter-cancel')?.toggleAttribute('hidden', !busy);
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
            state.session.candidate = turn.candidate;
            panel.querySelector('.story-rewriter-candidate').value = turn.candidate;
            panel.querySelector('.story-rewriter-preview').hidden = false;
            if (state.session.scopeMode === 'selection') {
                panel.querySelector('.story-rewriter-apply').disabled = false;
            } else {
                auditCurrentCandidate(panel);
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
        ? '酒馆提示链 · 当前完整消息 · 本地按需故事资料'
        : '当前完整消息 · 本地按需故事资料（完整提示链不可用时自动降级）') + limitLabel + responseLabel;
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
    session.audit = null;
    session.pendingTask = null;
    session.pendingInstruction = '';
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

    const fellBack = applyAutomaticContextFallback(panel);
    setWorkspaceBusy(panel, true, session.contextMode === 'tavern'
        ? '正在通过酒馆完整上下文调用当前模型…'
        : fellBack ? '完整上下文接口不可用，已降级到插件资料模式…' : '正在通过插件资料模式调用当前模型…');
    try {
        await syncContextSummary(panel);
        const task = buildSessionTask(instruction, panel);
        let response;
        if (session.contextMode === 'tavern' && typeof state.context.generateQuietPrompt === 'function') {
            response = await state.context.generateQuietPrompt({
                quietPrompt: buildFullContextRewritePrompt(task),
                quietToLoud: false,
                skipWIAN: false,
                responseLength: state.settings.responseLength,
                jsonSchema: REPLACEMENT_JSON_SCHEMA,
                removeReasoning: true,
                trimToSentence: false,
            });
        } else {
            if (typeof state.context.generateRaw !== 'function') throw new Error('当前 SillyTavern 不提供可用的后台生成接口。');
            response = await state.context.generateRaw({
                systemPrompt: DEFAULT_SYSTEM_PROMPT,
                prompt: buildRewritePrompt(task),
                responseLength: state.settings.responseLength,
                jsonSchema: REPLACEMENT_JSON_SCHEMA,
                trimNames: false,
            });
        }
        const candidate = cleanModelResponse(response);
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
        panel.querySelector('.story-rewriter-status').textContent = `生成失败：${error.message ?? error}`;
    } finally {
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

async function loadRepositoryWorldBooks(characters) {
    const names = new Set();
    for (const character of characters) {
        const name = character?.data?.extensions?.world;
        if (name) names.add(String(name));
    }
    const chatWorld = state.context.chatMetadata?.world_info;
    if (Array.isArray(chatWorld)) chatWorld.filter(Boolean).forEach(name => names.add(String(name)));
    else if (chatWorld) names.add(String(chatWorld));

    const books = [];
    const failures = [];
    for (const name of [...names].slice(0, 8)) {
        try {
            const data = await state.context.loadWorldInfo?.(name);
            if (data) books.push({ name, data });
            else failures.push(name);
        } catch (error) {
            console.warn(`[Story Rewriter] unable to load world info: ${name}`, error);
            failures.push(name);
        }
    }
    return { books, failures };
}

async function buildSemanticRepository(session, instruction, constraints) {
    refreshContext();
    const characters = getRepositoryCharacters();
    const { books, failures } = await loadRepositoryWorldBooks(characters);
    const chunks = [
        ...createCharacterChunks(characters),
        ...createWorldInfoChunks(books),
        ...createChatChunks(state.context.chat, session.capture.messageId),
    ];
    const query = [
        instruction,
        session.capture.selectedText,
        constraints,
        ...session.requirements.slice(-3),
    ].filter(Boolean).join('\n');
    const limits = session.activeLimits ?? await getActiveGenerationLimits();
    session.activeLimits = limits;
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
        if (session.cancelled) throw new Error('已取消本次生成。');
        let response;
        if (session.contextMode === 'tavern' && typeof state.context.generateQuietPrompt === 'function') {
            response = await state.context.generateQuietPrompt({
                quietPrompt: currentPrompt,
                quietToLoud: false,
                skipWIAN: false,
                responseLength,
                jsonSchema: schema,
                removeReasoning: true,
                trimToSentence: false,
            });
        } else {
            if (typeof state.context.generateRaw !== 'function') throw new Error('当前 SillyTavern 不提供可用的后台生成接口。');
            response = await state.context.generateRaw({
                systemPrompt: 'You are a source-grounded fiction editing agent. Follow the JSON schema and never reveal hidden reasoning.',
                prompt: currentPrompt,
                responseLength,
                jsonSchema: schema,
                trimNames: false,
            });
        }
        if (session.cancelled) throw new Error('已取消本次生成。');
        try {
            return parser(response);
        } catch (error) {
            lastError = error;
            if (attempt === 0) {
                const truncationHint = stageLabel === '影响分析' && /unterminated|unexpected end|end of json|截断/i.test(String(error.message ?? error))
                    ? '上次输出疑似被截断。必须大幅压缩：不要复制原文，不要输出引句，每个理由只写一句，省略低置信度关联，确保 JSON 完整闭合。'
                    : '';
                currentPrompt = `${prompt}\n\n<format_retry>上一次${stageLabel}未返回可解析的严格 JSON：${String(error.message ?? error)}。${truncationHint}重新执行原任务，只输出符合 Schema 的完整 JSON。</format_retry>`;
            }
        }
    }
    if (stageLabel === '影响分析' && /json|unterminated|unexpected end|截断/i.test(String(lastError?.message ?? lastError))) {
        throw new Error('模型连续两次返回了不完整的影响分析数据，通常是响应被截断。请提高当前预设的最大响应 Token，或减少按需资料条数。');
    }
    throw lastError ?? new Error(`${stageLabel}失败。`);
}

function getEffectiveImpactPlan(plan) {
    return {
        ...plan,
        linkedRegions: plan.linkedRegions.filter(region => region.enabled !== false),
        transitionRegions: plan.transitionRegions.filter(region => region.enabled !== false),
    };
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
            const confidence = typeof region.confidence === 'number' ? ` · ${Math.round(region.confidence * 100)}%` : '';
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
        warning.textContent = `未能单独读取世界书：${session.repository.failures.join('、')}。`;
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

function renderAudit(panel) {
    const session = state.session;
    const audit = session.audit;
    const summary = panel.querySelector('.story-rewriter-audit-summary');
    const host = panel.querySelector('.story-rewriter-diff-content');
    host.replaceChildren();
    if (!audit) {
        summary.textContent = '';
        return;
    }
    summary.textContent = `强修改 ${audit.counts.focus} 处 · 关联修改 ${audit.counts.linked} 处 · 衔接调整 ${audit.counts.transition} 处 · 疑似越界 ${audit.counts.protected} 处`;
    summary.className = `story-rewriter-audit-summary${audit.hardBlocked ? ' is-blocked' : audit.requiresOverride ? ' is-warning' : ''}`;

    for (const message of [...audit.conflicts, ...audit.warnings]) {
        const warning = document.createElement('p');
        warning.className = audit.conflicts.includes(message) ? 'story-rewriter-conflict' : 'story-rewriter-warning';
        warning.textContent = message;
        host.append(warning);
    }
    for (const change of audit.changes) {
        const card = document.createElement('article');
        card.className = `story-rewriter-diff-card is-${change.classification}`;
        const heading = document.createElement('strong');
        const names = { focus: '强修改', linked: '关联修改', transition: '衔接调整', protected: '疑似越界' };
        heading.textContent = `${names[change.classification]} · ${change.originalId ?? change.anchorId ?? '新增段落'}`;
        const before = document.createElement('pre');
        before.textContent = change.originalText || '（新增）';
        const after = document.createElement('pre');
        after.textContent = change.candidateText || '（删除）';
        card.append(heading, before, after);
        host.append(card);
    }
}

function auditCurrentCandidate(panel) {
    const session = state.session;
    if (!session || session.scopeMode === 'selection' || !session.impactPlan) return;
    const candidate = panel.querySelector('.story-rewriter-candidate').value.trim();
    if (!candidate) {
        session.audit = null;
        renderAudit(panel);
        return;
    }
    session.audit = auditRevision(session.capture.messageText, candidate, getEffectiveImpactPlan(session.impactPlan));
    renderAudit(panel);
    panel.querySelector('.story-rewriter-apply').disabled = session.audit.hardBlocked;
    panel.querySelector('.story-rewriter-replace').disabled = session.audit.hardBlocked;
}

function showCandidate(panel, candidate, instruction) {
    const session = state.session;
    session.candidate = candidate;
    session.requirements.push(instruction);
    if (session.requirements.length > MAX_SESSION_TURNS) session.requirements.shift();
    session.turns.push({ instruction, candidate, createdAt: new Date().toISOString() });
    if (session.turns.length > MAX_SESSION_TURNS) session.turns.shift();
    panel.querySelector('.story-rewriter-candidate').value = candidate;
    panel.querySelector('.story-rewriter-preview').hidden = false;
    panel.querySelector('.story-rewriter-generate').hidden = false;
    panel.querySelector('.story-rewriter-apply').disabled = false;
    panel.querySelector('.story-rewriter-replace').disabled = false;
    panel.querySelector('.story-rewriter-instruction').value = '';
    renderSessionTurns(panel);
    renderReferences(panel);
    auditCurrentCandidate(panel);
    panel.querySelector('.story-rewriter-status').textContent = session.audit?.hardBlocked
        ? '候选已生成，但审计发现阻断项。请调整要求或候选后重新检查。'
        : '新版本已生成。可以继续提出要求、查看修改，或应用为新版本。';
}

async function generateCompleteRevision(panel, instruction) {
    const session = state.session;
    const task = session.pendingTask;
    const effectivePlan = getEffectiveImpactPlan(session.impactPlan);
    setWorkspaceBusy(panel, true, '正在生成完整候选稿…');
    try {
        const limits = session.activeLimits ?? await getActiveGenerationLimits();
        session.activeLimits = limits;
        updateContextSummary(panel);
        const originalTokens = await countTokens(session.capture.messageText);
        const desiredResponseLength = desiredRevisionTokens(originalTokens);
        const revisionPrompt = buildRevisionPrompt({
            ...task,
            impactPlan: effectivePlan,
            previousCandidate: panel.querySelector('.story-rewriter-candidate').value.trim() || session.candidate,
            previousInstructions: session.requirements.slice(-MAX_SESSION_TURNS),
        });
        const promptTokens = await countTokens(revisionPrompt);
        const maxContext = limits.maxContext;
        const availableOutput = maxContext ? Math.floor(maxContext - promptTokens - 512) : desiredResponseLength;
        if (availableOutput < 512) {
            throw new Error(`完整候选请求约需 ${formatTokenCount(promptTokens + 512)}，当前预设上限为 ${formatTokenCount(maxContext)}。请缩短原文或资料。`);
        }
        const responseLength = Math.min(desiredResponseLength, availableOutput, limits.maxResponse || Number.POSITIVE_INFINITY);
        const revision = await generateStructured(
            revisionPrompt,
            REVISION_JSON_SCHEMA,
            responseLength,
            parseRevisionResponse,
            session,
            '完整重构',
        );
        if (state.session !== session || !panel.isConnected || session.cancelled) return;
        showCandidate(panel, revision.revisedMessage, instruction);
        session.pendingTask = null;
        session.pendingInstruction = '';
    } catch (error) {
        console.error('[Story Rewriter] complete revision failed', error);
        panel.querySelector('.story-rewriter-status').textContent = `生成失败：${error.message ?? error}`;
    } finally {
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
    session.cancelled = false;
    session.influence = session.scopeMode === 'selection' ? 'strict' : 'semantic';
    const constraints = panel.querySelector('.story-rewriter-constraints').value.trim();
    const fellBack = applyAutomaticContextFallback(panel);
    setWorkspaceBusy(panel, true, fellBack ? '完整上下文接口不可用，已降级并建立故事资料视图…' : '正在建立故事资料视图…');
    try {
        const limits = await syncContextSummary(panel);
        const paragraphs = segmentMessage(session.capture.messageText);
        const focusIds = session.editMode === 'full'
            ? []
            : getFocusParagraphIds(paragraphs, session.capture.range, session.editMode);
        if (session.editMode !== 'full' && !focusIds.length) throw new Error('无法把选区映射到原文段落。');
        const repository = await buildSemanticRepository(session, instruction, constraints);
        if (session.cancelled) throw new Error('已取消本次生成。');
        session.repository = repository;
        panel.querySelector('.story-rewriter-status').textContent = `找到 ${repository.retrieval.items.length} 条相关资料，正在识别影响范围…`;
        const mandatoryReferences = [{
            id: 'user-current-instruction',
            sourceType: 'instruction',
            sourceLabel: '用户本轮修改要求',
            text: instruction,
            authority: 'hard-rule',
        }];
        if (constraints) {
            mandatoryReferences.push({
                id: 'user-session-constraints',
                sourceType: 'instruction',
                sourceLabel: '本次编辑持续约束',
                text: constraints,
                authority: 'hard-rule',
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
        if (availableAnalysisOutput < 512) {
            throw new Error(`影响分析请求约需 ${formatTokenCount(promptTokens + 256)}，当前预设上限为 ${formatTokenCount(maxContext)}。请降低资料预算或缩小编辑目标。`);
        }
        const rawPlan = await generateStructured(
            impactPrompt,
            IMPACT_JSON_SCHEMA,
            Math.min(state.settings.analysisResponseLength, availableAnalysisOutput, limits.maxResponse || Number.POSITIVE_INFINITY),
            parseImpactResponse,
            session,
            '影响分析',
        );
        const plan = validateImpactPlan(rawPlan, paragraphs, focusIds, task.references.map(item => item.id));
        if (session.influence === 'strict') {
            plan.linkedRegions = plan.linkedRegions.filter(region => region.confidence >= 0.85).slice(0, 4);
            plan.transitionRegions = plan.transitionRegions.filter(region => region.confidence >= 0.75).slice(0, 2);
        }
        session.impactPlan = plan;
        session.pendingTask = task;
        session.pendingInstruction = instruction;
        renderImpactPlan(panel);
        renderReferences(panel);
    } catch (error) {
        console.error('[Story Rewriter] impact analysis failed', error);
        panel.querySelector('.story-rewriter-status').textContent = `分析失败：${error.message ?? error}`;
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
    return {
        version: 1,
        mode: session.editMode,
        scope: session.scopeMode,
        originalHash: session.capture.messageHash,
        instruction: session.requirements.at(-1) ?? session.pendingInstruction ?? '',
        requirements: session.requirements.slice(-MAX_SESSION_TURNS),
        influence: session.influence,
        impact: {
            focus: session.impactPlan?.focusRegions?.map(region => region.paragraphId) ?? [],
            linked: session.impactPlan?.linkedRegions?.filter(region => region.enabled !== false).map(region => region.paragraphId) ?? [],
            transition: session.impactPlan?.transitionRegions?.filter(region => region.enabled !== false).map(region => region.paragraphId) ?? [],
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

function confirmSoftWarnings(session) {
    if (!session.audit?.requiresOverride) return true;
    return globalThis.confirm?.('候选稿包含疑似无关修改或长度警告。仍然保存这个版本吗？') ?? false;
}

async function saveSemanticCandidateAsSwipe(panel) {
    const session = state.session;
    const candidate = panel.querySelector('.story-rewriter-candidate').value.trim();
    if (!candidate) return notify('候选内容不能为空。', 'warning');
    if (!captureIsCurrent(session?.capture)) return notify('原消息、聊天或 Swipe 已变化，未执行保存。', 'warning');
    auditCurrentCandidate(panel);
    if (session.audit?.hardBlocked) return notify('候选存在阻断项，不能保存。', 'warning');
    if (!confirmSoftWarnings(session)) return;

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
    if (session.audit?.hardBlocked) return notify('候选存在阻断项，不能替换。', 'warning');
    if (!confirmSoftWarnings(session)) return;
    if (!(globalThis.confirm?.('这会替换当前 Swipe 的完整消息。确认继续吗？') ?? false)) return;

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
        turns: [],
        repository: null,
        impactPlan: null,
        audit: null,
        pendingTask: null,
        pendingInstruction: '',
        cancelled: false,
        activeLimits: null,
    };

    const semantic = true;
    const panel = document.createElement('aside');
    panel.id = 'story-rewriter-panel';
    panel.className = 'story-rewriter-ui story-rewriter-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'story-rewriter-title');
    panel.innerHTML = `
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

            <details open>
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
                    <button type="button" class="story-rewriter-view-tab" data-view="changes">查看修改</button>
                    <button type="button" class="story-rewriter-view-tab is-active" data-view="full">新版本</button>
                    <button type="button" class="story-rewriter-view-tab" data-view="sources">使用的资料</button>
                </div>
                <div class="story-rewriter-audit-summary"></div>
                <section class="story-rewriter-view story-rewriter-diff" data-view="changes" hidden>
                    <details class="story-rewriter-impact" hidden open>
                        <summary>Agent 识别的影响范围</summary>
                        <div class="story-rewriter-impact-content"></div>
                    </details>
                    <div class="story-rewriter-diff-content"></div>
                </section>
                <section class="story-rewriter-view" data-view="full">
                    <div class="story-rewriter-compare">
                        <div><span>原文</span><pre class="story-rewriter-compare-original"></pre></div>
                        <div><label for="story-rewriter-candidate">候选（可编辑）</label><textarea id="story-rewriter-candidate" class="text_pole story-rewriter-candidate" rows="14"></textarea></div>
                    </div>
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
    panel.querySelector('.story-rewriter-compare-original').textContent = capture.messageText;
    panel.querySelectorAll('input[name="story-rewriter-scope"]').forEach(input => {
        input.addEventListener('change', event => {
            if (!event.currentTarget.checked) return;
            state.session.scopeMode = SCOPE_MODES.has(event.currentTarget.value) ? event.currentTarget.value : 'smart';
            resetSessionForScopeChange(panel);
            const original = panel.querySelector('.story-rewriter-compare-original');
            if (original) original.textContent = state.session.scopeMode === 'selection'
                ? state.session.capture.range.rawText
                : state.session.capture.messageText;
            panel.querySelector('.story-rewriter-status').textContent = state.session.scopeMode === 'selection'
                ? '只会生成选区的替换文字，圈外内容保持不变。'
                : '会识别相关段落并生成完整新版本。';
            updateScopeInterface(panel);
        });
    });
    panel.querySelector('.story-rewriter-close').addEventListener('click', closeWorkspace);
    panel.querySelector('.story-rewriter-cancel').addEventListener('click', () => {
        if (!state.session) return;
        state.session.cancelled = true;
        state.context.stopGeneration?.();
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
            auditCurrentCandidate(panel);
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
