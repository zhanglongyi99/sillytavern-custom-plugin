export const DIAGNOSTICS_SCHEMA_VERSION = 1;
export const MAX_DIAGNOSTIC_RUNS = 30;
export const MAX_EVENTS_PER_RUN = 100;

const RUN_FIELDS = new Set([
    'extensionVersion', 'editMode', 'scopeMode', 'contextMode',
    'contextLimit', 'responseLimit', 'limitSource',
]);

const EVENT_FIELDS = new Set([
    'stage', 'segment', 'attempt', 'responseLength', 'promptTokens',
    'pluginPromptCharacters', 'pluginPromptFingerprint', 'elapsedMs',
    'responseCharacters', 'providerCharacters', 'usableCharacters',
    'complete', 'errorCode', 'stopReason', 'parseOutcome',
    'coverageRatio', 'retrievalItems', 'retrievalCharacters',
    'contextLimit', 'responseLimit', 'limitSource', 'outcome',
]);

function safePrimitive(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'string') return value.slice(0, 160);
    return undefined;
}

function selectFields(value, allowed) {
    if (!value || typeof value !== 'object') return {};
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => allowed.has(key))
        .map(([key, item]) => [key, safePrimitive(item)])
        .filter(([, item]) => item !== undefined));
}

function createSummary() {
    return {
        modelCalls: 0,
        successfulCalls: 0,
        timeouts: 0,
        cancellations: 0,
        errors: 0,
        totalElapsedMs: 0,
        providerCharacters: 0,
        usableCharacters: 0,
        parseOutcomes: {},
    };
}

export function createDiagnosticArchive() {
    return {
        schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
        capabilities: {
            providerCacheUsage: 'unavailable_from_quiet_generation_api',
            promptFingerprintScope: 'plugin_prompt_only',
        },
        runs: [],
    };
}

function normalizeEvent(value) {
    if (!value || typeof value !== 'object') return null;
    const event = safePrimitive(value.event);
    const at = safePrimitive(value.at);
    if (!event || !at) return null;
    return { event, at, ...selectFields(value, EVENT_FIELDS) };
}

function summarizeEvents(events) {
    const summary = createSummary();
    for (const event of events) {
        if (event.event === 'start') summary.modelCalls++;
        if (event.event === 'success') summary.successfulCalls++;
        if (event.event === 'timeout') summary.timeouts++;
        if (event.event === 'cancelled') summary.cancellations++;
        if (event.event === 'error') summary.errors++;
        summary.totalElapsedMs += Number(event.elapsedMs) || 0;
        if (event.event === 'parsed') {
            summary.providerCharacters += Number(event.providerCharacters) || 0;
            summary.usableCharacters += Number(event.usableCharacters) || 0;
            if (event.parseOutcome) {
                summary.parseOutcomes[event.parseOutcome] = (summary.parseOutcomes[event.parseOutcome] ?? 0) + 1;
            }
        }
    }
    return summary;
}

function normalizeRun(value) {
    if (!value || typeof value !== 'object') return null;
    const id = safePrimitive(value.id);
    const startedAt = safePrimitive(value.startedAt);
    if (!id || !startedAt) return null;
    const events = Array.isArray(value.events)
        ? value.events.map(normalizeEvent).filter(Boolean).slice(-MAX_EVENTS_PER_RUN)
        : [];
    return {
        id,
        startedAt,
        endedAt: safePrimitive(value.endedAt) ?? null,
        status: safePrimitive(value.status) ?? 'running',
        ...selectFields(value, RUN_FIELDS),
        events,
        summary: summarizeEvents(events),
    };
}

export function normalizeDiagnosticArchive(value) {
    const archive = createDiagnosticArchive();
    if (!value || typeof value !== 'object' || !Array.isArray(value.runs)) return archive;
    archive.runs = value.runs.map(normalizeRun).filter(Boolean).slice(-MAX_DIAGNOSTIC_RUNS);
    return archive;
}

export function addDiagnosticRun(archive, { id, startedAt, ...metadata }) {
    const normalized = normalizeDiagnosticArchive(archive);
    const run = normalizeRun({
        id,
        startedAt,
        status: 'running',
        ...selectFields(metadata, RUN_FIELDS),
        events: [],
    });
    if (!run) throw new Error('Invalid diagnostic run');
    normalized.runs.push(run);
    normalized.runs = normalized.runs.slice(-MAX_DIAGNOSTIC_RUNS);
    return normalized;
}

export function appendDiagnosticEvent(archive, runId, event, metadata, at) {
    const normalized = normalizeDiagnosticArchive(archive);
    const run = normalized.runs.find(item => item.id === runId);
    if (!run) return normalized;
    const nextEvent = normalizeEvent({ event, at, ...selectFields(metadata, EVENT_FIELDS) });
    if (!nextEvent) return normalized;
    run.events.push(nextEvent);
    run.events = run.events.slice(-MAX_EVENTS_PER_RUN);
    run.summary = summarizeEvents(run.events);
    return normalized;
}

export function finishDiagnosticRun(archive, runId, status, endedAt) {
    const normalized = normalizeDiagnosticArchive(archive);
    const run = normalized.runs.find(item => item.id === runId);
    if (!run) return normalized;
    run.status = safePrimitive(status) ?? 'unknown';
    run.endedAt = safePrimitive(endedAt) ?? null;
    return normalized;
}

export function exportDiagnosticArchive(archive, exportedAt) {
    return {
        ...normalizeDiagnosticArchive(archive),
        exportedAt: safePrimitive(exportedAt) ?? null,
    };
}
