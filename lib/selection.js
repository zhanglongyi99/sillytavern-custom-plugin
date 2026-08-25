const QUOTE_REPLACEMENTS = new Map([
    ['\u2018', "'"], ['\u2019', "'"], ['\u201a', "'"], ['\u201b', "'"], ['\u2032', "'"],
    ['\u201c', '"'], ['\u201d', '"'], ['\u201e', '"'], ['\u201f', '"'], ['\u2033', '"'],
]);

const NAMED_ENTITIES = new Map([
    ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&nbsp;', ' '],
]);

function decodeEntity(raw, index) {
    for (const [entity, value] of NAMED_ENTITIES) {
        if (raw.startsWith(entity, index)) return { value, length: entity.length };
    }

    const match = raw.slice(index).match(/^&#(?:x([\da-f]+)|(\d+));/i);
    if (!match) return null;
    const codePoint = Number.parseInt(match[1] ?? match[2], match[1] ? 16 : 10);
    if (!Number.isFinite(codePoint)) return null;
    try {
        return { value: String.fromCodePoint(codePoint), length: match[0].length };
    } catch {
        return null;
    }
}

function appendCharacter(output, map, character, rawIndex) {
    output.push(character);
    map.push(rawIndex);
}

/**
 * Approximates rendered message text while mapping visible characters back to
 * raw Markdown offsets. It covers the common markup used in story responses.
 * @param {string} raw
 * @returns {{ text: string, map: number[] }}
 */
export function projectMarkdown(raw) {
    const output = [];
    const map = [];
    let index = 0;
    let lineStart = true;

    while (index < raw.length) {
        if (lineStart) {
            const prefix = raw.slice(index).match(/^( {0,3})(?:#{1,6}|>|[-+*]|\d+\.)[ \t]+/);
            if (prefix) {
                index += prefix[0].length;
                lineStart = false;
                continue;
            }
        }

        const character = raw[index];
        if (character === '\r') {
            index++;
            continue;
        }
        if (character === '\n') {
            appendCharacter(output, map, '\n', index++);
            lineStart = true;
            continue;
        }
        lineStart = false;

        if (character === '\\' && index + 1 < raw.length) {
            appendCharacter(output, map, raw[index + 1], index + 1);
            index += 2;
            continue;
        }

        if (character === '&') {
            const entity = decodeEntity(raw, index);
            if (entity) {
                for (const decodedCharacter of entity.value) appendCharacter(output, map, decodedCharacter, index);
                index += entity.length;
                continue;
            }
        }

        if (character === '<') {
            const closingIndex = raw.indexOf('>', index + 1);
            if (closingIndex !== -1) {
                const tag = raw.slice(index, closingIndex + 1);
                if (/^<br\s*\/?\s*>$/i.test(tag)) appendCharacter(output, map, '\n', index);
                index = closingIndex + 1;
                continue;
            }
        }

        if (character === '!' && raw[index + 1] === '[') {
            const labelEnd = raw.indexOf(']', index + 2);
            const targetStart = labelEnd === -1 ? -1 : raw.indexOf('(', labelEnd + 1);
            const targetEnd = targetStart === -1 ? -1 : raw.indexOf(')', targetStart + 1);
            if (labelEnd !== -1 && targetStart === labelEnd + 1 && targetEnd !== -1) {
                index = targetEnd + 1;
                continue;
            }
        }

        if (character === '[') {
            const labelEnd = raw.indexOf(']', index + 1);
            const targetStart = labelEnd === -1 ? -1 : raw.indexOf('(', labelEnd + 1);
            const targetEnd = targetStart === -1 ? -1 : raw.indexOf(')', targetStart + 1);
            if (labelEnd !== -1 && targetStart === labelEnd + 1 && targetEnd !== -1) {
                for (let labelIndex = index + 1; labelIndex < labelEnd; labelIndex++) {
                    appendCharacter(output, map, raw[labelIndex], labelIndex);
                }
                index = targetEnd + 1;
                continue;
            }
        }

        if (character === '`') {
            index += raw.slice(index).match(/^`+/)?.[0].length ?? 1;
            continue;
        }

        if (character === '*' || character === '_' || character === '~') {
            const escaped = character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const runLength = raw.slice(index).match(new RegExp(`^${escaped}+`))?.[0].length ?? 1;
            if (runLength <= 3) {
                index += runLength;
                continue;
            }
        }

        appendCharacter(output, map, character, index++);
    }

    return { text: output.join(''), map };
}

function normalizeProjection(text, sourceMap = null) {
    const output = [];
    const map = [];
    let whitespaceOpen = false;

    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (/[\u200b-\u200f\ufeff]/.test(character)) continue;
        if (/\s/.test(character)) {
            if (!whitespaceOpen) {
                output.push(' ');
                map.push(sourceMap?.[index] ?? index);
                whitespaceOpen = true;
            }
            continue;
        }
        whitespaceOpen = false;
        output.push(QUOTE_REPLACEMENTS.get(character) ?? character);
        map.push(sourceMap?.[index] ?? index);
    }

    return { text: output.join(''), map };
}

export function normalizeComparable(text) {
    return normalizeProjection(String(text ?? '')).text.trim();
}

function findAll(haystack, needle) {
    const matches = [];
    let fromIndex = 0;
    while (fromIndex <= haystack.length - needle.length) {
        const index = haystack.indexOf(needle, fromIndex);
        if (index === -1) break;
        matches.push(index);
        fromIndex = index + Math.max(1, needle.length);
    }
    return matches;
}

/**
 * Locates the raw Markdown range represented by a visible DOM selection.
 * @param {string} raw
 * @param {string} selectedText
 * @param {number} [visibleStart=0]
 * @returns {{ start: number, end: number, rawText: string } | null}
 */
export function findSelectionRange(raw, selectedText, visibleStart = 0) {
    if (!raw || !selectedText) return null;
    const projection = projectMarkdown(raw);
    const normalized = normalizeProjection(projection.text, projection.map);
    const needle = normalizeComparable(selectedText);
    if (!needle) return null;

    let matches = findAll(normalized.text, needle);
    if (!matches.length) matches = findAll(normalized.text.toLocaleLowerCase(), needle.toLocaleLowerCase());
    if (!matches.length) return null;

    const normalizedVisibleStart = normalizeComparable(projection.text.slice(0, Math.max(0, visibleStart))).length;
    const matchStart = matches.reduce((closest, candidate) => (
        Math.abs(candidate - normalizedVisibleStart) < Math.abs(closest - normalizedVisibleStart)
            ? candidate
            : closest
    ), matches[0]);
    const matchEnd = matchStart + needle.length - 1;
    const rawStart = normalized.map[matchStart];
    const finalRawCharacter = normalized.map[matchEnd];
    if (!Number.isInteger(rawStart) || !Number.isInteger(finalRawCharacter)) return null;

    const rawEnd = finalRawCharacter + 1;
    return { start: rawStart, end: rawEnd, rawText: raw.slice(rawStart, rawEnd) };
}

export function replaceRange(raw, range, replacement) {
    if (!range || range.start < 0 || range.end < range.start || range.end > raw.length) {
        throw new RangeError('Invalid replacement range.');
    }
    return `${raw.slice(0, range.start)}${replacement}${raw.slice(range.end)}`;
}
