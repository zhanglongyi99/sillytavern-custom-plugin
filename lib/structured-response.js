// Never recover a report from an explicit reasoning block or expose its text.
export function createHostJsonSchema(schema, attempt) {
    return attempt === 0 && schema ? { ...schema, returnInvalid: true } : null;
}

export function stripExplicitReasoning(value) {
    return String(value ?? '')
        .replace(/<(think|thinking|analysis|reasoning|thought|system-reminder)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<(?:think|thinking|analysis|reasoning|thought|system-reminder)(?:\s[^>]*)?>[\s\S]*$/gi, '')
        .trim();
}

export function parseStructuredResponse(response, parser, configuredCleaner = value => value) {
    const raw = String(response ?? '');
    const clean = stripExplicitReasoning(raw);
    const metadata = { interfaceCharacters: raw.length, cleanedCharacters: clean.length };
    let error;
    if (clean) {
        try { return { value: parser(clean), metadata: { ...metadata, parseOutcome: 'explicit_cleanup' } }; }
        catch (failure) { error = failure; }
        // A valid report takes precedence over configurable reasoning heuristics.
        let configured = clean;
        try { configured = stripExplicitReasoning(configuredCleaner(clean)); } catch { /* retain original error */ }
        metadata.configuredCharacters = configured.length;
        if (configured && configured !== clean) {
            try { return { value: parser(configured), metadata: { ...metadata, parseOutcome: 'configured_cleanup' } }; }
            catch (failure) { error = failure; }
        }
    }
    const code = !raw.trim() ? 'empty_response'
        : !clean ? 'empty_after_cleanup'
        : /^\{\s*\}$/.test(clean) ? 'empty_object'
        : metadata.configuredCharacters === 0 ? 'empty_after_configured_cleanup'
        : error instanceof SyntaxError
            ? !/[{\[]/.test(clean) ? 'non_json'
                : hasUnclosedJson(clean) ? 'incomplete_json' : 'invalid_json'
            : 'invalid_report';
    return { value: null, metadata: { ...metadata, errorCode: code, parseOutcome: code } };
}

function hasUnclosedJson(text) {
    const start = text.search(/[{\[]/);
    let quoted = false;
    let escaped = false;
    const stack = [];
    for (const character of text.slice(start)) {
        if (quoted) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') quoted = false;
        } else if (character === '"') quoted = true;
        else if (character === '{' || character === '[') stack.push(character);
        else if (character === '}' || character === ']') {
            if (stack.pop() !== (character === '}' ? '{' : '[')) return false;
            if (!stack.length) return false;
        }
    }
    return quoted || stack.length > 0;
}

export function structuredFailureMessage(code) {
    return ({
        empty_response: '接口未返回可用文本',
        empty_object: '接口返回空对象，缺少报告字段；可能是上游输出或宿主解析回退',
        empty_after_cleanup: '移除显式推理块后没有可用报告',
        empty_after_configured_cleanup: '文本未通过报告解析，配置清理后为空',
        non_json: '返回文本不是检查所需的 JSON 报告',
        incomplete_json: '返回的 JSON 报告未完整闭合',
        invalid_json: '返回的 JSON 格式损坏',
        invalid_report: '返回数据不符合报告结构要求',
    })[code] ?? '未得到有效报告';
}

export function structuredRetryHint(code) {
    if (code === 'empty_object') return '上一轮只得到空对象。请按完整字段返回报告；确实没有问题时也需提供 objective、queries 和 issues，不要只返回 {}。';
    if (code.startsWith('empty_')) {
        return '上一轮没有可用报告。请在最终回答中直接输出报告 JSON，不要只返回推理或空内容。';
    }
    if (code === 'incomplete_json') {
        return '上一轮报告未完整闭合。压缩措辞，优先明确问题，保留必要证据短引句，不复制整章，确保 JSON 完整闭合。';
    }
    return '上一轮数据格式或结构无效。严格按指定字段和类型返回报告，不要解释格式或复述任务。';
}
