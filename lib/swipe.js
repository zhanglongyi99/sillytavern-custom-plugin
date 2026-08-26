export const REVISION_METADATA_KEY = 'story_rewriter_revision';

function cloneValue(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

function createSwipeInfo(message, extra) {
    return {
        send_date: message.send_date,
        gen_started: null,
        gen_finished: null,
        extra,
    };
}

/**
 * Appends a complete revision as a new active Swipe while preserving the
 * current message and its per-swipe metadata.
 */
export function appendRevisionSwipe(message, nextText, revisionMetadata, now = Date.now()) {
    if (!message || typeof message !== 'object' || message.is_user || message.is_system) {
        throw new TypeError('Only ordinary assistant messages can receive revision swipes.');
    }
    if (typeof nextText !== 'string' || !nextText.trim()) throw new TypeError('Revision text must not be empty.');

    if (!Array.isArray(message.swipes)) message.swipes = [String(message.mes ?? '')];
    if (!Number.isInteger(message.swipe_id) || message.swipe_id < 0 || message.swipe_id >= message.swipes.length) message.swipe_id = 0;
    if (!Array.isArray(message.swipe_info)) message.swipe_info = message.swipes.map(() => ({}));
    while (message.swipe_info.length < message.swipes.length) message.swipe_info.push({});

    const currentId = message.swipe_id;
    message.swipes[currentId] = String(message.mes ?? '');
    message.swipe_info[currentId] = {
        ...message.swipe_info[currentId],
        send_date: message.send_date,
        gen_started: message.gen_started,
        gen_finished: message.gen_finished,
        extra: cloneValue(message.extra ?? {}),
    };

    const candidateExtra = cloneValue(message.extra ?? {});
    delete candidateExtra.display_text;
    candidateExtra[REVISION_METADATA_KEY] = cloneValue(revisionMetadata);
    candidateExtra.api = 'manual';
    candidateExtra.model = 'Story Rewriter';
    candidateExtra.gen_id = now;

    message.swipes.push(nextText);
    message.swipe_info.push(createSwipeInfo(message, cloneValue(candidateExtra)));
    message.swipe_id = message.swipes.length - 1;
    message.mes = nextText;
    message.extra = candidateExtra;
    return message.swipe_id;
}
