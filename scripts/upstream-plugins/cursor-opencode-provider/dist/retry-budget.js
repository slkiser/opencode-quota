import { CursorRetryExhaustedError } from "./errors.js";
import { processShared } from "./process-shared.js";
const budgets = () => processShared("run-retry-budgets.v1", () => new Map());
const MAX_SESSIONS = 1_024;
const MAX_TURNS_PER_SESSION = 16;
export function newRetryBudget() {
    return { server: 0, transport: 0, retries: 0 };
}
/** A host retry or tool continuation must not mint a fresh retry allowance. */
export function turnRetryBudget(sessionKey, turnKey, continuationKey) {
    if (!sessionKey)
        return newRetryBudget();
    const sessions = budgets();
    let turns = sessions.get(sessionKey);
    if (!turns) {
        turns = new Map();
    }
    sessions.delete(sessionKey);
    sessions.set(sessionKey, turns);
    const lookup = (key) => {
        const direct = turns.get(key);
        return direct ? [key, direct] : [...turns].find(([, budget]) => budget.hostRetryKey === key);
    };
    let entry = lookup(turnKey);
    let budget = entry?.[1];
    const currentKey = turnKey;
    if (entry)
        turnKey = entry[0];
    if (!budget && continuationKey !== undefined) {
        entry = lookup(continuationKey);
        const previous = entry?.[1];
        if (previous?.hostRetryPending) {
            budget = previous;
            budget.hostRetryKey = currentKey;
            turnKey = entry[0];
        }
    }
    if (!budget) {
        budget = newRetryBudget();
    }
    budget.hostRetryPending = false;
    turns.delete(turnKey);
    turns.set(turnKey, budget);
    // Abandoned host retries and ephemeral helpers never reach turn_ended.
    // Bound their lookup records; live recovery loops retain their budget object.
    while (turns.size > MAX_TURNS_PER_SESSION)
        turns.delete(turns.keys().next().value);
    while (sessions.size > MAX_SESSIONS)
        sessions.delete(sessions.keys().next().value);
    return budget;
}
export function forgetRetryBudget(sessionKey, budget) {
    if (!sessionKey)
        return;
    const sessions = budgets();
    const turns = sessions.get(sessionKey);
    if (!turns)
        return;
    if (!budget)
        sessions.delete(sessionKey);
    else {
        for (const [key, value] of turns)
            if (value === budget)
                turns.delete(key);
        if (turns.size === 0)
            sessions.delete(sessionKey);
    }
}
export function endlessRetriesEnabled() {
    return process.env.CURSOR_ENDLESS_RETRIES === "1" || process.env.CURSOR_ENDLESS_RETRIES === "true";
}
/** CLI's incomplete-stream error is explicitly transport; an idle deadline is server. */
export function retryCategory(failure) {
    return failure.origin === "transport"
        && failure.code !== "CURSOR_READ_IDLE_TIMEOUT" ? "transport" : "server";
}
/** Reserve one retry before either reopening locally or handing it to OpenCode. */
export function reserveRetry(budget, failure, maxAttempts, now = Date.now()) {
    const category = retryCategory(failure);
    const stalled = failure.code === "CURSOR_SEMANTIC_IDLE_TIMEOUT";
    if (!stalled)
        budget.stallStartedAt = undefined;
    const stallExpired = stalled && budget.stallStartedAt !== undefined && now - budget.stallStartedAt >= 180_000;
    if (stallExpired || (!endlessRetriesEnabled() && (budget[category] >= (category === "server" ? 3 : 10)
        || (maxAttempts !== undefined && budget.retries >= maxAttempts - 1))))
        throw new CursorRetryExhaustedError(budget.retries + 1, failure);
    if (stalled)
        budget.stallStartedAt ??= now;
    budget[category]++;
    budget.retries++;
}
export function resetRetryBudgetsForTests() {
    budgets().clear();
}
