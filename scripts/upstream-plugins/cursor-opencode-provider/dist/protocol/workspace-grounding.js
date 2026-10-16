const ABSOLUTE_PATH_ARG = "OpenCode file tools take `path` as an absolute path under this root. Do not pass a project-relative path, and do not invent a different absolute prefix.";
/**
 * Attach the exact workspace root to a model-visible string.
 *
 * Idempotent: a second call does not stack another root line. The absolute-path
 * sentence is added only when requested, and only once.
 */
export function appendWorkspaceRootGrounding(reason, workspaceRoot, options) {
    if (!workspaceRoot || !workspaceRoot.trim())
        return reason;
    const pathSentence = options?.requireAbsolutePathArg ? ` ${ABSOLUTE_PATH_ARG}` : "";
    if (reason.includes("Workspace root:")) {
        if (!pathSentence || reason.includes("take `path` as an absolute path"))
            return reason;
        return `${reason}${pathSentence}`;
    }
    const note = `Workspace root: ${JSON.stringify(workspaceRoot)}. ` +
        "Resolve workspace paths against exactly this root; never invent an absolute prefix, and verify uncertain paths with an available tool before using them." +
        pathSentence;
    if (!reason)
        return note;
    return `${reason}\n${note}`;
}
/**
 * Checkpointed Runs omit the system prompt, which is where the root normally
 * lives. Put the same reminder on the live user message so a later turn cannot
 * invent an absolute prefix before any tool result arrives.
 */
export function appendCheckpointUserGrounding(userText, workspaceRoot, options) {
    const note = appendWorkspaceRootGrounding("", workspaceRoot, options);
    if (!note)
        return userText;
    if (userText.includes("Workspace root:")) {
        return appendWorkspaceRootGrounding(userText, workspaceRoot, options);
    }
    return userText ? `${userText}\n\n${note}` : note;
}
