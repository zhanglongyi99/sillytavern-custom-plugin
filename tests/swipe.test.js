import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRevisionSwipe, REVISION_METADATA_KEY } from '../lib/swipe.js';

test('creates swipes and preserves the original assistant message', () => {
    const message = { mes: '原文', extra: { note: 'keep', display_text: '原文' }, send_date: 'today' };
    const swipeId = appendRevisionSwipe(message, '候选全文', { mode: 'semantic' }, 123);
    assert.equal(swipeId, 1);
    assert.deepEqual(message.swipes, ['原文', '候选全文']);
    assert.equal(message.mes, '候选全文');
    assert.equal(message.extra.display_text, undefined);
    assert.equal(message.extra[REVISION_METADATA_KEY].mode, 'semantic');
    assert.equal(message.swipe_info[0].extra.display_text, '原文');
    assert.equal(message.swipe_info[1].extra.gen_id, 123);
});

test('syncs edits to the active swipe before appending a revision', () => {
    const message = {
        mes: '手动编辑后的当前版本',
        swipes: ['旧版本', '另一个版本'],
        swipe_id: 0,
        swipe_info: [{ extra: {} }, { extra: {} }],
        extra: { current: true },
    };
    appendRevisionSwipe(message, '新候选', { mode: 'full' }, 456);
    assert.deepEqual(message.swipes, ['手动编辑后的当前版本', '另一个版本', '新候选']);
    assert.equal(message.swipe_info[0].extra.current, true);
    assert.equal(message.swipe_id, 2);
});

test('rejects user and system messages', () => {
    assert.throws(() => appendRevisionSwipe({ mes: '用户', is_user: true }, '候选', {}));
    assert.throws(() => appendRevisionSwipe({ mes: '系统', is_system: true }, '候选', {}));
});
