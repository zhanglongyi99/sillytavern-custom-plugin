import { findSelectionRange, replaceRange } from './lib/selection.js';
import {
    DEFAULT_SYSTEM_PROMPT,
    buildFullContextRewritePrompt,
    buildRewritePrompt,
    cleanModelResponse,
    createRewriteTask,
} from './lib/rewrite.js';

const EXTENSION_KEY = 'story_rewriter';
const HISTORY_KEY = 'story_rewriter_history';
const MAX_HISTORY = 5;
const MAX_SESSION_TURNS = 8;
const CONTEXT_MODES = new Set(['tavern', 'local']);
const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    contextMode: 'tavern',
    contextCharacters: 2000,
    responseLength: 1024,
    persistentUndo: true,
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
    sessionHistory: new WeakMap(),
};

function notify(message, type = 'info') {
    const method = globalThis.toastr?.[type];
    if (typeof method === 'function') method(message, '故事局部改写');
    else console[type === 'error' ? 'error' : 'log'](`[Story Rewriter] ${message}`);
}

function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function loadSettings() {
    const stored = state.context.extensionSettings?.[EXTENSION_KEY] ?? {};
    state.settings = {
        ...DEFAULT_SETTINGS,
        ...stored,
        enabled: stored.enabled ?? DEFAULT_SETTINGS.enabled,
        contextMode: CONTEXT_MODES.has(stored.contextMode) ? stored.contextMode : DEFAULT_SETTINGS.contextMode,
        contextCharacters: clampNumber(stored.contextCharacters, 0, 8000, DEFAULT_SETTINGS.contextCharacters),
        responseLength: clampNumber(stored.responseLength, 64, 4096, DEFAULT_SETTINGS.responseLength),
        persistentUndo: stored.persistentUndo ?? DEFAULT_SETTINGS.persistentUndo,
    };
    state.context.extensionSettings[EXTENSION_KEY] = state.settings;
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
    const persistentUndo = document.querySelector('#story_rewriter_persistent_undo');
    enabled.checked = state.settings.enabled;
    contextMode.value = state.settings.contextMode;
    contextCharacters.value = String(state.settings.contextCharacters);
    responseLength.value = String(state.settings.responseLength);
    persistentUndo.checked = state.settings.persistentUndo;

    enabled.addEventListener('change', () => {
        state.settings.enabled = enabled.checked;
        if (!enabled.checked) hideActionButton();
        saveSettings();
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
    persistentUndo.addEventListener('change', () => {
        state.settings.persistentUndo = persistentUndo.checked;
        saveSettings();
        ensureUndoButtons();
    });
}

function createActionButton() {
    const button = document.createElement('button');
    button.id = 'story-rewriter-action';
    button.type = 'button';
    button.className = 'story-rewriter-action';
    button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>局部改写</span>';
    button.hidden = true;
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => openRewriteWorkspace());
    document.body.append(button);
    state.actionButton = button;
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
    if (!state.active || !state.settings.enabled) return hideActionButton();
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

    const rect = range.getBoundingClientRect().width || range.getBoundingClientRect().height
        ? range.getBoundingClientRect()
        : range.getClientRects()[0];
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

function onSelectionGesture(event) {
    if (event.target?.closest?.('.story-rewriter-ui')) return;
    window.setTimeout(captureSelection, 0);
}

function closeWorkspace() {
    state.panel?.remove();
    state.panel = null;
    state.session = null;
    hideActionButton();
}

function setWorkspaceBusy(panel, busy, status = '') {
    panel.dataset.busy = String(busy);
    panel.querySelectorAll('button, select').forEach(element => {
        element.disabled = busy;
    });
    panel.querySelectorAll('textarea').forEach(element => {
        if (!element.classList.contains('story-rewriter-original')) element.disabled = busy;
    });
    if (!busy) {
        const candidate = panel.querySelector('.story-rewriter-candidate');
        panel.querySelector('.story-rewriter-apply').disabled = !candidate.value.trim();
    }
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
            panel.querySelector('.story-rewriter-apply').disabled = false;
            panel.querySelector('.story-rewriter-status').textContent = `已恢复第 ${index + 1} 轮候选。`;
        });
        card.append(requestLabel, request, resultLabel, result, restore);
        host.append(card);
    }
    host.hidden = state.session.turns.length === 0;
}

function updateContextSummary(panel) {
    const fullContext = state.session.contextMode === 'tavern';
    panel.querySelector('.story-rewriter-context-summary').textContent = fullContext
        ? '角色卡 · 世界书 · 作者注 · 扩展提示 · 当前聊天历史'
        : `仅选区前后各 ${state.settings.contextCharacters} 字`;
    const timelineNotice = panel.querySelector('.story-rewriter-timeline-notice');
    timelineNotice.hidden = !fullContext || state.session.capture.messageId >= state.context.chat.length - 1;
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

async function generateCandidate(panel) {
    const session = state.session;
    const instructionInput = panel.querySelector('.story-rewriter-instruction');
    const instruction = instructionInput.value.trim();
    if (!instruction) {
        panel.querySelector('.story-rewriter-status').textContent = '请先输入本轮修改要求。';
        return;
    }
    const capture = session?.capture;
    if (!capture || capture.message.mes !== capture.messageText) {
        panel.querySelector('.story-rewriter-status').textContent = '原消息已变化，请关闭工作台后重新选择。';
        return;
    }

    setWorkspaceBusy(panel, true, session.contextMode === 'tavern'
        ? '正在通过酒馆完整上下文调用当前模型…'
        : '正在通过局部上下文调用当前模型…');
    try {
        const task = buildSessionTask(instruction, panel);
        let response;
        if (session.contextMode === 'tavern') {
            if (typeof state.context.generateQuietPrompt !== 'function') {
                throw new Error('当前 SillyTavern 不提供完整上下文后台生成接口。');
            }
            response = await state.context.generateQuietPrompt({
                quietPrompt: buildFullContextRewritePrompt(task),
                quietToLoud: false,
                skipWIAN: false,
                responseLength: state.settings.responseLength,
                removeReasoning: true,
                trimToSentence: false,
            });
        } else {
            response = await state.context.generateRaw({
                systemPrompt: DEFAULT_SYSTEM_PROMPT,
                prompt: buildRewritePrompt(task),
                responseLength: state.settings.responseLength,
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
        panel.querySelector('.story-rewriter-status').textContent = '候选已生成。可以继续提出要求，或确认替换。';
    } catch (error) {
        console.error('[Story Rewriter] generation failed', error);
        panel.querySelector('.story-rewriter-status').textContent = `生成失败：${error.message ?? error}`;
    } finally {
        if (panel.isConnected && state.panel === panel) {
            setWorkspaceBusy(panel, false, panel.querySelector('.story-rewriter-status').textContent);
        }
    }
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
        ensureUndoButtons();
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

async function applyCandidate(panel) {
    const candidate = panel.querySelector('.story-rewriter-candidate').value.trim();
    if (!candidate) return notify('候选内容不能为空。', 'warning');
    const capture = state.session?.capture;
    if (!capture || capture.message.mes !== capture.messageText) {
        return notify('原消息已变化，未执行替换。', 'warning');
    }

    const previousText = capture.messageText;
    const originalSelection = previousText.slice(capture.range.start, capture.range.end);
    const nextText = replaceRange(previousText, capture.range, candidate);
    const history = getHistory(capture.message);
    const previousHistory = history.slice();
    history.push({
        start: capture.range.start,
        before: originalSelection,
        after: candidate,
        instruction: state.session.requirements.join('\n'),
        constraints: panel.querySelector('.story-rewriter-constraints').value.trim(),
        contextMode: state.session.contextMode,
        createdAt: new Date().toISOString(),
    });
    while (history.length > MAX_HISTORY) history.shift();
    updateHistory(capture.message, history);

    setWorkspaceBusy(panel, true, '正在写回并保存聊天…');
    try {
        await persistMessageText(capture.message, nextText, previousText);
        closeWorkspace();
        showUndoSnackbar(capture.message);
        notify('已替换选中片段。', 'success');
    } catch (error) {
        history.splice(0, history.length, ...previousHistory);
        updateHistory(capture.message, history);
        ensureUndoButtons();
        notify(`替换失败：${error.message ?? error}`, 'error');
        if (panel.isConnected && state.panel === panel) {
            setWorkspaceBusy(panel, false, `替换失败：${error.message ?? error}`);
        }
    }
}

function openRewriteWorkspace() {
    if (!state.capture) return;
    closeWorkspace();
    hideActionButton();
    const capture = {
        ...state.capture,
        range: { ...state.capture.range },
    };
    state.session = {
        capture,
        contextMode: state.settings.contextMode,
        constraints: '',
        requirements: [],
        candidate: '',
        turns: [],
    };

    const panel = document.createElement('aside');
    panel.id = 'story-rewriter-panel';
    panel.className = 'story-rewriter-ui story-rewriter-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-labelledby', 'story-rewriter-title');
    panel.innerHTML = `
        <header class="story-rewriter-panel-header">
            <div><h3 id="story-rewriter-title">故事局部改写</h3><small>消息 #${capture.messageId}</small></div>
            <button type="button" class="story-rewriter-close" aria-label="关闭">×</button>
        </header>
        <div class="story-rewriter-panel-body">
            <section class="story-rewriter-context-card">
                <label for="story-rewriter-session-context">本次使用的上下文</label>
                <select id="story-rewriter-session-context" class="text_pole story-rewriter-context-mode">
                    <option value="tavern">完整酒馆上下文（推荐）</option>
                    <option value="local">局部快速模式</option>
                </select>
                <small class="story-rewriter-context-summary"></small>
                <small class="story-rewriter-timeline-notice">目标是历史消息；完整模式会参考它之后的现有剧情，以减少前后冲突。</small>
            </section>

            <details open>
                <summary>目标原文</summary>
                <textarea class="text_pole story-rewriter-original" rows="6" readonly></textarea>
            </details>

            <label for="story-rewriter-constraints">必须持续保留的约束（可选）</label>
            <textarea id="story-rewriter-constraints" class="text_pole story-rewriter-constraints" rows="3" placeholder="例如：不改变事件顺序、人物关系和第三人称视角。"></textarea>

            <div class="story-rewriter-turns" aria-label="本次编辑历史" hidden></div>

            <section class="story-rewriter-preview" hidden>
                <h4>原文与当前候选</h4>
                <div class="story-rewriter-compare">
                    <div><span>原文</span><pre class="story-rewriter-compare-original"></pre></div>
                    <div><label for="story-rewriter-candidate">候选（可编辑）</label><textarea id="story-rewriter-candidate" class="text_pole story-rewriter-candidate" rows="10"></textarea></div>
                </div>
            </section>
        </div>
        <footer class="story-rewriter-panel-footer">
            <label for="story-rewriter-instruction">本轮修改要求</label>
            <textarea id="story-rewriter-instruction" class="text_pole story-rewriter-instruction" rows="3" placeholder="第一次可以说明完整目标；之后可输入“再克制一点”等继续调整。"></textarea>
            <div class="story-rewriter-actions">
                <button type="button" class="menu_button story-rewriter-generate">生成候选</button>
                <button type="button" class="menu_button story-rewriter-apply" disabled>确认替换</button>
            </div>
            <div class="story-rewriter-status" role="status" aria-live="polite">选区只决定修改范围；上下文由上方模式决定。</div>
        </footer>`;

    panel.querySelector('.story-rewriter-original').value = capture.range.rawText;
    panel.querySelector('.story-rewriter-compare-original').textContent = capture.range.rawText;
    const contextMode = panel.querySelector('.story-rewriter-context-mode');
    contextMode.value = state.session.contextMode;
    contextMode.addEventListener('change', () => {
        state.session.contextMode = CONTEXT_MODES.has(contextMode.value) ? contextMode.value : DEFAULT_SETTINGS.contextMode;
        state.settings.contextMode = state.session.contextMode;
        const settingsContextMode = document.querySelector('#story_rewriter_context_mode');
        if (settingsContextMode) settingsContextMode.value = state.settings.contextMode;
        saveSettings();
        updateContextSummary(panel);
    });
    panel.querySelector('.story-rewriter-close').addEventListener('click', closeWorkspace);
    panel.querySelector('.story-rewriter-generate').addEventListener('click', () => generateCandidate(panel));
    panel.querySelector('.story-rewriter-apply').addEventListener('click', () => applyCandidate(panel));
    panel.querySelector('.story-rewriter-candidate').addEventListener('input', event => {
        state.session.candidate = event.currentTarget.value;
        panel.querySelector('.story-rewriter-apply').disabled = !event.currentTarget.value.trim();
    });
    panel.querySelector('.story-rewriter-instruction').addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            void generateCandidate(panel);
        }
    });
    document.body.append(panel);
    state.panel = panel;
    updateContextSummary(panel);
    panel.querySelector('.story-rewriter-instruction').focus();
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
        ensureUndoButtons();
        notify(`撤销失败：${error.message ?? error}`, 'error');
    }
}

function showUndoSnackbar(message) {
    state.snackbar?.remove();
    const snackbar = document.createElement('div');
    snackbar.className = 'story-rewriter-ui story-rewriter-snackbar';
    snackbar.innerHTML = '<span>已完成局部替换</span><button type="button">撤销</button>';
    snackbar.querySelector('button').addEventListener('click', () => undoMessage(message));
    document.body.append(snackbar);
    state.snackbar = snackbar;
    window.setTimeout(() => {
        if (state.snackbar === snackbar) {
            snackbar.remove();
            state.snackbar = null;
        }
    }, 8000);
}

function ensureUndoButtons() {
    if (!state.active) return;
    for (const element of document.querySelectorAll('.mes')) {
        const messageId = Number(element.getAttribute('mesid'));
        const message = state.context.chat?.[messageId];
        const existing = element.querySelector('.story-rewriter-undo');
        const history = state.settings.persistentUndo && message && !message.is_user && !message.is_system
            ? message.extra?.[HISTORY_KEY]
            : null;
        if (!Array.isArray(history) || !history.length) {
            existing?.remove();
            continue;
        }
        if (existing) continue;
        const host = element.querySelector('.mes_buttons');
        if (!host) continue;
        const button = document.createElement('div');
        button.className = 'mes_button story-rewriter-undo fa-solid fa-rotate-left interactable';
        button.title = '撤销上一次局部改写';
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
        ensureUndoButtons();
    });
}

function onDocumentClick(event) {
    const button = event.target.closest?.('.story-rewriter-undo');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const messageId = Number(button.closest('.mes')?.getAttribute('mesid'));
    const message = state.context.chat?.[messageId];
    if (message) void undoMessage(message);
}

function onKeyDown(event) {
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
    document.addEventListener('mouseup', onSelectionGesture);
    document.addEventListener('keyup', onSelectionGesture);
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', hideActionButton);
    document.addEventListener('scroll', hideActionButton, true);
    state.observer = new MutationObserver(queueUndoButtonRefresh);
    state.observer.observe(document.querySelector('#chat') ?? document.body, { childList: true, subtree: true });
    ensureUndoButtons();
    console.info('[Story Rewriter] activated');
}

export function deactivate() {
    if (!state.active) return;
    state.active = false;
    document.removeEventListener('mouseup', onSelectionGesture);
    document.removeEventListener('keyup', onSelectionGesture);
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', hideActionButton);
    document.removeEventListener('scroll', hideActionButton, true);
    state.observer?.disconnect();
    state.observer = null;
    state.actionButton?.remove();
    state.actionButton = null;
    closeWorkspace();
    state.snackbar?.remove();
    state.snackbar = null;
    document.querySelector('#story_rewriter_settings')?.remove();
    document.querySelectorAll('.story-rewriter-undo').forEach(element => element.remove());
}
