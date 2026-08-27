export class GenerationTimeoutError extends Error {
    constructor(stage, timeoutMs) {
        super(`${stage}超过 ${Math.round(timeoutMs / 1000)} 秒仍未返回，已停止等待。`);
        this.name = 'GenerationTimeoutError';
        this.code = 'GENERATION_TIMEOUT';
        this.stage = stage;
        this.timeoutMs = timeoutMs;
    }
}

export class GenerationCancelledError extends Error {
    constructor(message = '已取消本次生成。') {
        super(message);
        this.name = 'GenerationCancelledError';
        this.code = 'GENERATION_CANCELLED';
    }
}

export function isGenerationCancelled(error) {
    return error?.code === 'GENERATION_CANCELLED' || error?.name === 'AbortError';
}

export function isGenerationTimeout(error) {
    return error?.code === 'GENERATION_TIMEOUT';
}

function cancellationFromSignal(signal) {
    return signal?.reason instanceof Error
        ? signal.reason
        : new GenerationCancelledError();
}

/**
 * Race one model call against a timeout and the active editing-session signal.
 * The underlying provider promise may remain alive, but its late result can no
 * longer mutate the caller after this guard rejects.
 */
export async function runGuardedGeneration({
    operation,
    timeoutMs,
    signal,
    onTimeout,
    logger = () => {},
    metadata = {},
}) {
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    if (signal?.aborted) throw cancellationFromSignal(signal);

    const startedAt = Date.now();
    let timeoutId;
    let abortHandler;
    logger('start', { ...metadata });

    const operationPromise = Promise.resolve().then(operation);
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            try {
                onTimeout?.();
            } catch {
                // Stopping the provider is best effort; the timeout still wins.
            }
            reject(new GenerationTimeoutError(metadata.stage ?? '模型调用', timeoutMs));
        }, timeoutMs);
    });
    const races = [operationPromise, timeoutPromise];
    if (signal) {
        races.push(new Promise((_, reject) => {
            abortHandler = () => reject(cancellationFromSignal(signal));
            signal.addEventListener('abort', abortHandler, { once: true });
        }));
    }

    try {
        const result = await Promise.race(races);
        logger('success', {
            ...metadata,
            elapsedMs: Date.now() - startedAt,
            responseCharacters: typeof result === 'string' ? result.length : undefined,
        });
        return result;
    } catch (error) {
        const event = isGenerationTimeout(error)
            ? 'timeout'
            : isGenerationCancelled(error) ? 'cancelled' : 'error';
        logger(event, {
            ...metadata,
            elapsedMs: Date.now() - startedAt,
            errorCode: error?.code ?? error?.name ?? 'Error',
        });
        throw error;
    } finally {
        clearTimeout(timeoutId);
        if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    }
}
