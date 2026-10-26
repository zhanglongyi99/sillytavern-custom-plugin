// Local assembled-text allowance, not provider billing or reasoning-token usage.
export function revisionBudget({ estimatedOutput, totalLimit, usedTokens = 0, contextAvailable = Infinity, responseLimit = Infinity }) {
    const remaining = Math.max(0, totalLimit - usedTokens);
    const request = Math.max(0, Math.floor(Math.min(estimatedOutput, remaining, contextAvailable, responseLimit)));
    const stopReason = contextAvailable < 256 ? 'context_exhausted'
        : responseLimit < 256 ? 'response_limit'
            : remaining < 256 ? 'budget_exhausted' : '';
    return { remaining, request, stopReason };
}
