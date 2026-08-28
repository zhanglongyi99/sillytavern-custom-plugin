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

function splitUnescapedPipes(line) {
    const cells = [];
    let start = 0;
    let backslashes = 0;

    for (let index = 0; index < line.length; index++) {
        const character = line[index];
        if (character === '\\') {
            backslashes++;
            continue;
        }
        if (character === '|' && backslashes % 2 === 0) {
            cells.push(line.slice(start, index));
            start = index + 1;
        }
        backslashes = 0;
    }
    cells.push(line.slice(start));
    return cells;
}

function isMarkdownTableDivider(line) {
    const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = splitUnescapedPipes(trimmed);
    return cells.length >= 2 && cells.every(cell => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function hasUnescapedPipe(line) {
    return splitUnescapedPipes(line).length >= 2;
}

function isMarkdownThematicBreak(line) {
    return /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
}

/**
 * Finds Markdown table rows. Their pipes and delimiter row do not exist as
 * selectable text in the rendered message, while browsers insert whitespace
 * between the resulting table cells.
 * @param {string} raw
 * @returns {Map<number, { end: number, divider: boolean }>}
 */
function findMarkdownTableLines(raw) {
    const lines = [];
    let start = 0;
    while (start <= raw.length) {
        const newline = raw.indexOf('\n', start);
        const end = newline === -1 ? raw.length : newline;
        const contentEnd = end > start && raw[end - 1] === '\r' ? end - 1 : end;
        lines.push({ start, end: contentEnd, text: raw.slice(start, contentEnd) });
        if (newline === -1) break;
        start = newline + 1;
    }

    const tableLines = new Map();
    for (let index = 1; index < lines.length; index++) {
        if (!isMarkdownTableDivider(lines[index].text) || !hasUnescapedPipe(lines[index - 1].text)) continue;

        const header = lines[index - 1];
        tableLines.set(header.start, { end: header.end, divider: false });
        tableLines.set(lines[index].start, { end: lines[index].end, divider: true });

        for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex++) {
            const body = lines[bodyIndex];
            if (!body.text.trim() || !hasUnescapedPipe(body.text)) break;
            tableLines.set(body.start, { end: body.end, divider: false });
            index = bodyIndex;
        }
    }
    return tableLines;
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
    const markdownTableLines = findMarkdownTableLines(raw);
    let index = 0;
    let lineStart = true;
    let markdownTableLine = null;

    while (index < raw.length) {
        if (lineStart) {
            markdownTableLine = markdownTableLines.get(index) ?? null;
            if (markdownTableLine?.divider) {
                index = markdownTableLine.end;
                lineStart = false;
                continue;
            }
            const lineEnd = raw.indexOf('\n', index);
            const contentEnd = lineEnd === -1 ? raw.length : lineEnd;
            const line = raw.slice(index, contentEnd).replace(/\r$/, '');
            if (isMarkdownThematicBreak(line)) {
                index = contentEnd;
                lineStart = false;
                continue;
            }
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
            markdownTableLine = null;
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
                if (/^<\/(?:td|th|tr|table|p|div|li|blockquote|h[1-6]|summary|details)\s*>$/i.test(tag)) {
                    appendCharacter(output, map, '\n', index);
                }
                index = closingIndex + 1;
                continue;
            }
        }

        if (markdownTableLine && index < markdownTableLine.end && character === '|') {
            appendCharacter(output, map, ' ', index++);
            continue;
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

        if (character === '*' || character === '_') {
            const escaped = character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const runLength = raw.slice(index).match(new RegExp(`^${escaped}+`))?.[0].length ?? 1;
            if (runLength <= 3) {
                index += runLength;
                continue;
            }
        }

        if (character === '~' && raw[index + 1] === '~' && raw[index + 2] !== '~') {
            index += 2;
            continue;
        }

        appendCharacter(output, map, character, index++);
    }

    return { text: output.join(''), map };
}

function normalizeProjection(text, sourceMap = null, ignoreWhitespace = false) {
    const output = [];
    const map = [];
    let whitespaceOpen = false;

    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (/[\u200b-\u200f\ufeff]/.test(character)) continue;
        if (/\s/.test(character)) {
            if (ignoreWhitespace) continue;
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

/**
 * Picks the last visible text rectangle from a DOM selection. Long selections
 * may have a bounding rectangle spanning several viewports, so positioning UI
 * from the individual visible line rectangles is more reliable.
 * @param {Iterable<{top: number, right: number, bottom: number, left: number, width: number, height: number}>} rects
 * @param {number} viewportWidth
 * @param {number} viewportHeight
 * @returns {{top: number, right: number, bottom: number, left: number, width: number, height: number} | null}
 */
export function chooseVisibleSelectionRect(rects, viewportWidth, viewportHeight) {
    const visible = Array.from(rects ?? []).filter(rect => {
        if (!rect || (!rect.width && !rect.height)) return false;
        return rect.bottom >= 0
            && rect.top <= viewportHeight
            && rect.right >= 0
            && rect.left <= viewportWidth;
    });
    return visible.at(-1) ?? null;
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

function locateProjectedSelection(projection, selectedText, visibleStart, ignoreWhitespace = false) {
    const normalized = normalizeProjection(projection.text, projection.map, ignoreWhitespace);
    const needle = normalizeProjection(String(selectedText ?? ''), null, ignoreWhitespace).text.trim();
    if (!needle) return null;

    let matches = findAll(normalized.text, needle);
    if (!matches.length) matches = findAll(normalized.text.toLocaleLowerCase(), needle.toLocaleLowerCase());
    if (!matches.length) return null;

    const visiblePrefix = projection.text.slice(0, Math.max(0, visibleStart));
    const normalizedVisibleStart = normalizeProjection(visiblePrefix, null, ignoreWhitespace).text.trim().length;
    const matchStart = matches.reduce((closest, candidate) => (
        Math.abs(candidate - normalizedVisibleStart) < Math.abs(closest - normalizedVisibleStart)
            ? candidate
            : closest
    ), matches[0]);
    return { normalized, matchStart, needleLength: needle.length };
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
    // Browser Range text is inconsistent around rendered table cells: some
    // engines insert tabs/newlines, while others concatenate adjacent cells.
    // Keep the whitespace-aware lookup as the primary path, then use a compact
    // structural fallback only when the exact visible-text projection fails.
    const located = locateProjectedSelection(projection, selectedText, visibleStart, false)
        ?? locateProjectedSelection(projection, selectedText, visibleStart, true);
    if (!located) return null;

    const { normalized, matchStart, needleLength } = located;
    const matchEnd = matchStart + needleLength - 1;
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
