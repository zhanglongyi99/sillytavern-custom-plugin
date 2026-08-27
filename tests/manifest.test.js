import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('keeps package and extension versions aligned', () => {
    assert.equal(manifest.version, packageJson.version);
});

test('declares the standard SillyTavern frontend extension entry points', () => {
    assert.equal(manifest.js, 'index.js');
    assert.equal(manifest.css, 'style.css');
    assert.equal(manifest.hooks.activate, 'activate');
    assert.equal(manifest.hooks.disable, 'deactivate');
    assert.equal(manifest.minimum_client_version, '1.17.0');
});

test('publishes the continuation recovery release metadata', () => {
    assert.equal(manifest.version, '0.6.1');
    assert.equal(manifest.display_name, '故事改写');
});
