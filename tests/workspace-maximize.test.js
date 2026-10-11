import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const runtime = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');

test('maximize overrides drag width while minimized bubble retains priority', () => {
    const maximized = styles.match(/\.story-rewriter-panel\.is-maximized\s*\{([^}]+)\}/)[1];
    assert.match(maximized, /inset:\s*10px/);
    assert.match(maximized, /width:\s*auto\s*!important/);
    assert.match(maximized, /max-width:\s*none/);
    // The combined selector is more specific than maximized and comes later.
    const bubble = styles.match(/\.story-rewriter-panel\.is-maximized\.is-minimized\s*\{([^}]+)\}/)[1];
    assert.match(bubble, /width:\s*56px\s*!important/);
});

test('maximize and bubble transitions stop dragging and preserve restored width', () => {
    const functions = runtime.slice(runtime.indexOf('function toggleWorkspaceMaximized('), runtime.indexOf('function enablePanelResize('));
    let cleaned = 0;
    const state = { panelResizeCleanup: () => cleaned++ };
    const { maximize, minimize } = new Function('state', `${functions}; return { maximize: toggleWorkspaceMaximized, minimize: setWorkspaceMinimized };`)(state);
    const classes = new Set();
    const button = { setAttribute() {}, title: '', innerHTML: '' };
    const bubble = { hidden: true, focus() {} };
    const panel = { isConnected: true, style: { width: '1500px' },
        classList: { toggle(name, force) { const on = force ?? !classes.has(name); on ? classes.add(name) : classes.delete(name); return on; } },
        querySelector(selector) { return selector.endsWith('maximize') ? button : selector.endsWith('restore-bubble') ? bubble : { focus() {} }; } };
    maximize(panel);
    assert.equal(classes.has('is-maximized'), true);
    assert.equal(button.title, '还原工作台');
    minimize(panel, true);
    assert.equal(bubble.hidden, false);
    minimize(panel, false);
    assert.equal(classes.has('is-maximized'), true);
    maximize(panel);
    assert.equal(classes.has('is-maximized'), false);
    assert.equal(panel.style.width, '1500px');
    assert.equal(cleaned, 4);
});
