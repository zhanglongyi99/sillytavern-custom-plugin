import { findSelectionRange, replaceRange } from './lib/selection.js';
import {
    DEFAULT_SYSTEM_PROMPT,
    buildRewritePrompt,
    cleanModelResponse,
    createRewriteTask,
} from './lib/rewrite.js';

const EXTENSION_KEY = 'story_rewriter';
const HISTORY_KEY = 'story_rewriter_history';
const MAX_HISTORY = 5;
const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
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
    modal: null,
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
    const contextCharacters = document.querySelector('#story_rewriter_context_chars');
    const responseLength = document.querySelector('#story_rewriter_response_length');
    const persistentUndo = document.querySelector('#story_rewriter_persistent_undo');
    enabled.checked = state.settings.enabled;
    contextCharacters.value = String(state.settings.contextCharacters);
    responseLength.value = String(state.settings.responseLength);
    persistentUndo.checked = state.settings.persistentUndo;

    enabled.addEventListener('change', () => {
        state.settings.enabled = enabled.checked;
        if (!enabled.checked) hideActionButton();
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
    button.addEventListener('click', () => openRewriteDialog());
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
    if (!state.active || !state.settings.enabled || state.modal) return hideActionButton();
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

function makeButton(label, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button story-rewriter-dialog-button ${className}`.trim();
    button.textContent = label;
    return button;
}

function closeDialog() {
    state.modal?.remove();
    state.modal = null;
    hideActionButton();
}

function setDialogBusy(dialog, busy, status = '') {
    dialog.dataset.busy = String(busy);
    dialog.querySelectorAll('button').forEach(element => {
        element.disabled = busy;
    });
    dialog.querySelectorAll('textarea').forEach(element => {
        if (!element.classList.contains('story-rewriter-original')) element.disabled = busy;
    });
    if (!busy) {
        const candidate = dialog.querySelector('.story-rewriter-candidate');
        dialog.querySelector('.story-rewriter-apply').disabled = !candidate.value.trim();
    }
    dialog.querySelector('.story-rewriter-status').textContent = status;
}

async function generateCandidate(dialog) {
    const instruction = dialog.querySelector('.story-rewriter-instruction').value.trim();
    if (!instruction) {
        dialog.querySelector('.story-rewriter-status').textContent = '请先输入修改要求。';
        return;
    }
    const capture = state.capture;
    if (!capture || capture.message.mes !== capture.messageText) {
        dialog.querySelector('.story-rewriter-status').textContent = '原消息已变化，请关闭后重新选择。';
        return;
    }

    setDialogBusy(dialog, true, '正在调用当前模型…');
    try {
        const task = createRewriteTask(capture.messageText, capture.range, instruction, state.settings.contextCharacters);
        const response = await state.context.generateRaw({
            systemPrompt: DEFAULT_SYSTEM_PROMPT,
            prompt: buildRewritePrompt(task),
            responseLength: state.settings.responseLength,
            trimNames: false,
        });
        const candidate = cleanModelResponse(response);
        if (!candidate) throw new Error('模型返回了空内容。');
        dialog.querySelector('.story-rewriter-candidate').value = candidate;
        dialog.querySelector('.story-rewriter-preview').hidden = false;
        dialog.querySelector('.story-rewriter-apply').disabled = false;
        dialog.querySelector('.story-rewriter-status').textContent = '候选结果已生成，可编辑后再替换。';
    } catch (error) {
        console.error('[Story Rewriter] generation failed', error);
        dialog.querySelector('.story-rewriter-status').textContent = `生成失败：${error.message ?? error}`;
    } finally {
        setDialogBusy(dialog, false, dialog.querySelector('.story-rewriter-status').textContent);
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
    const previousSwipe = Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)
        ? message.swipes[message.swipe_id]
        : undefined;
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
        if (previousSwipe !== undefined) message.swipes[message.swipe_id] = previousSwipe;
        if (message.extra) {
            if (hadDisplayText) message.extra.display_text = previousDisplayText;
            else delete message.extra.display_text;
        }
        if (state.context.chatMetadata) state.context.chatMetadata.tainted = previousTainted;
        state.context.updateMessageBlock(messageId, message);
        throw error;
    }
}

async function applyCandidate(dialog) {
    const candidate = dialog.querySelector('.story-rewriter-candidate').value.trim();
    if (!candidate) return notify('候选内容不能为空。', 'warning');
    const capture = state.capture;
    if (!capture || capture.message.mes !== capture.messageText) {
        return notify('原消息已变化，未执行替换。', 'warning');
    }

    const previousText = capture.messageText;
    const originalSelection = previousText.slice(capture.range.start, capture.range.end);
    const nextText = replaceRange(previousText, capture.range, candidate);
    const history = getHistory(capture.message);
    history.push({
        start: capture.range.start,
        before: originalSelection,
        after: candidate,
        createdAt: new Date().toISOString(),
    });
    while (history.length > MAX_HISTORY) history.shift();
    updateHistory(capture.message, history);

    try {
        await persistMessageText(capture.message, nextText, previousText);
        closeDialog();
        showUndoSnackbar(capture.message);
        notify('已替换选中片段。', 'success');
    } catch (error) {
        history.pop();
        updateHistory(capture.message, history);
        notify(`替换失败：${error.message ?? error}`, 'error');
    }
}

function openRewriteDialog() {
    if (!state.capture || state.modal) return;
    hideActionButton();
    const backdrop = document.createElement('div');
    backdrop.className = 'story-rewriter-ui story-rewriter-backdrop';
    backdrop.innerHTML = `
        <section class="story-rewriter-dialog" role="dialog" aria-modal="true" aria-labelledby="story-rewriter-title">
            <header><h3 id="story-rewriter-title">故事局部改写</h3><button type="button" class="story-rewriter-close" aria-label="关闭">×</button></header>
            <label>原文选区</label>
            <textarea class="text_pole story-rewriter-original" rows="5" readonly></textarea>
            <label>修改要求</label>
            <textarea class="text_pole story-rewriter-instruction" rows="4" placeholder="例如：保留事件不变，改成更克制、更紧张的第三人称描写。"></textarea>
            <div class="story-rewriter-actions"><button type="button" class="menu_button story-rewriter-generate">生成候选</button><button type="button" class="menu_button story-rewriter-cancel">取消</button></div>
            <div class="story-rewriter-preview" hidden><label>候选替换文本（可手动编辑）</label><textarea class="text_pole story-rewriter-candidate" rows="8"></textarea><div class="story-rewriter-actions"><button type="button" class="menu_button story-rewriter-apply" disabled>确认替换</button><button type="button" class="menu_button story-rewriter-regenerate">重新生成</button></div></div>
            <div class="story-rewriter-status" role="status" aria-live="polite"></div>
        </section>`;
    backdrop.querySelector('.story-rewriter-original').value = state.capture.range.rawText;
    backdrop.querySelector('.story-rewriter-close').addEventListener('click', closeDialog);
    backdrop.querySelector('.story-rewriter-cancel').addEventListener('click', closeDialog);
    backdrop.querySelector('.story-rewriter-generate').addEventListener('click', () => generateCandidate(backdrop));
    backdrop.querySelector('.story-rewriter-regenerate').addEventListener('click', () => generateCandidate(backdrop));
    backdrop.querySelector('.story-rewriter-apply').addEventListener('click', () => applyCandidate(backdrop));
    backdrop.querySelector('.story-rewriter-candidate').addEventListener('input', event => {
        backdrop.querySelector('.story-rewriter-apply').disabled = !event.currentTarget.value.trim();
    });
    backdrop.addEventListener('mousedown', event => {
        if (event.target === backdrop) closeDialog();
    });
    document.body.append(backdrop);
    state.modal = backdrop;
    backdrop.querySelector('.story-rewriter-instruction').focus();
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
    if (event.key === 'Escape' && state.modal) closeDialog();
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
    closeDialog();
    state.snackbar?.remove();
    state.snackbar = null;
    document.querySelector('#story_rewriter_settings')?.remove();
    document.querySelectorAll('.story-rewriter-undo').forEach(element => element.remove());
}
