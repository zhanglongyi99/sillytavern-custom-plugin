// Presentation-only character diff. Never normalize text used for saving.
export function diffInline(original, candidate, maxCells = 1000000) {
    const left = Array.from(original);
    const right = Array.from(candidate);
    const result = { original: [], candidate: [] };
    const append = (side, text, changed) => {
        if (!text) return;
        const parts = result[side];
        if (parts.at(-1)?.changed === changed) parts.at(-1).text += text;
        else parts.push({ text, changed });
    };
    let start = 0;
    while (start < left.length && start < right.length && left[start] === right[start]) start++;
    let end = 0;
    while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
    const prefix = left.slice(0, start).join('');
    append('original', prefix, false);
    append('candidate', prefix, false);
    const a = left.slice(start, left.length - end);
    const b = right.slice(start, right.length - end);
    // Bound work for large rewrites: highlight the changed region as a whole.
    if (!a.length || !b.length || (a.length + 1) * (b.length + 1) > maxCells) {
        append('original', a.join(''), true);
        append('candidate', b.join(''), true);
    } else {
        const width = b.length + 1;
        const table = new Uint32Array((a.length + 1) * width);
        for (let i = a.length - 1; i >= 0; i--) {
            for (let j = b.length - 1; j >= 0; j--) {
                table[i * width + j] = a[i] === b[j]
                    ? table[(i + 1) * width + j + 1] + 1
                    : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < a.length || j < b.length) {
            if (i < a.length && j < b.length && a[i] === b[j]) {
                append('original', a[i++], false);
                append('candidate', b[j++], false);
            } else if (i < a.length && (j === b.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
                append('original', a[i++], true);
            } else append('candidate', b[j++], true);
        }
    }
    const suffix = end ? left.slice(-end).join('') : '';
    append('original', suffix, false);
    append('candidate', suffix, false);
    return result;
}
