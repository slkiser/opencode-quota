/**
 * Cursor-native CreatePlan → host-default plan file.
 *
 * Cursor raises `create_plan_request_query` (#7) with CreatePlanArgs and expects
 * a CreatePlanResult carrying `plan_uri`. Cursor CLI writes under
 * `~/.cursor/plans/*.plan.md` with YAML frontmatter; this provider deliberately
 * does **not** — plans must stay host-portable so switching models does not
 * strand users on Cursor-specific paths or frontmatter.
 *
 * Location is the host's own: the session plan file when the host defines one
 * (`hostPlanFilePath`, OpenCode 1.x `Session.plan`), otherwise a new
 * `<created>-<slug>.md` under {@link hostPlansDir} (OpenCode 2.0's Plan
 * directory, OpenCode 1.x `<data>/plans`, or an installed path bridge).
 *
 * Body is plain markdown (the same shape a plan-mode model would write with
 * `write`). Cursor YAML frontmatter is never emitted.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hostPlansDir } from "../context/paths.js";
import { decodeMessageSparse } from "./messages.js";
import { errorMessage } from "../debug.js";
import { parseAnswerSegments, } from "./ask-question.js";
const PLAN_ADJECTIVES = [
    "brave",
    "calm",
    "clever",
    "cosmic",
    "crisp",
    "curious",
    "eager",
    "gentle",
    "glowing",
    "happy",
    "hidden",
    "jolly",
    "kind",
    "lucky",
    "mighty",
    "misty",
    "neon",
    "nimble",
    "playful",
    "proud",
    "quick",
    "quiet",
    "shiny",
    "silent",
    "stellar",
    "sunny",
    "swift",
    "tidy",
    "witty",
];
const PLAN_NOUNS = [
    "cabin",
    "cactus",
    "canyon",
    "circuit",
    "comet",
    "eagle",
    "engine",
    "falcon",
    "forest",
    "garden",
    "harbor",
    "island",
    "knight",
    "lagoon",
    "meadow",
    "moon",
    "mountain",
    "nebula",
    "orchid",
    "otter",
    "panda",
    "pixel",
    "planet",
    "river",
    "rocket",
    "sailor",
    "squid",
    "star",
    "tiger",
    "wizard",
    "wolf",
];
/** Optional host plan-stage tool advertised by a compatible host. */
export const CURSOR_PLAN_STAGE_TOOL = "cursor_plan_stage";
/** Held InteractionQuery continuation field for a native host plan stage. */
export const CREATE_PLAN_RESULT_FIELD = "create_plan_request_response";
/** CreatePlan raised before an approved switch into the host plan agent took effect. */
export const CREATE_PLAN_HOST_PLAN_PENDING_REASON = "Plan mode starts in the host's plan agent after this turn. Do not record the plan " +
    "now and make no further tool calls: end this turn. Planning continues in the next " +
    "turn under the host's plan-mode instructions.";
/** CreatePlan raised while the host's own plan agent owns the plan file and its review. */
export const CREATE_PLAN_HOST_PLAN_WORKFLOW_REASON = "This host's plan agent owns the plan file and its approval. Write the plan where the " +
    "plan-mode instructions say, then call `plan_exit` to ask the user to approve it. Do " +
    "not implement until it is approved.";
/** Cursor-visible reason when the user wants the plan revised instead of run. */
export const CREATE_PLAN_NOT_APPROVED_REASON = "The user did not approve executing this plan. Keep planning: refine the plan and "
    + "propose it again when it is ready.";
/** Upstream `PlanExitTool` wording, with the plan the provider just wrote. */
export function createPlanApprovalQuestion(planLabel) {
    const where = planLabel.trim();
    return where
        ? `Plan at ${where} is complete. Would you like to switch to the build agent and start implementing?`
        : "The plan is complete. Would you like to switch to the build agent and start implementing?";
}
export const CREATE_PLAN_APPROVAL_HEADER = "Build Agent";
const CREATE_PLAN_APPROVAL_YES = "Yes";
const CREATE_PLAN_APPROVAL_NO = "No";
/** Resolve how this CreatePlan is satisfied (see {@link CreatePlanBridge}). */
export function resolveCreatePlanBridge(options) {
    // A lifecycle turn (title generation, compaction) runs alongside the real one
    // and must not write a second plan file or raise a second prompt.
    if (!options.allowTools)
        return { kind: "ack" };
    if (options.hostPlanEntryPending) {
        return { kind: "defer", reason: CREATE_PLAN_HOST_PLAN_PENDING_REASON };
    }
    if (options.canStage)
        return { kind: "stage" };
    const names = options.advertised instanceof Set ? options.advertised : new Set(options.advertised);
    if (options.hostAgent === "plan" && names.has("plan_exit")) {
        return options.hostPlanFile
            ? { kind: "exit", planPath: options.hostPlanFile }
            : { kind: "defer", reason: CREATE_PLAN_HOST_PLAN_WORKFLOW_REASON };
    }
    const planModeActive = options.planModeActive === true || options.hostAgent === "plan";
    if (planModeActive && names.has("question"))
        return { kind: "approve" };
    return { kind: "ack" };
}
function createPlanApprovalItem(question) {
    return {
        id: "create_plan_approval",
        prompt: question,
        options: [
            { id: "yes", label: CREATE_PLAN_APPROVAL_YES },
            { id: "no", label: CREATE_PLAN_APPROVAL_NO },
        ],
        allowMultiple: false,
    };
}
/** Host `question` input mirroring upstream `PlanExitTool`'s own prompt. */
export function createPlanApprovalQuestionInput(planLabel) {
    return {
        questions: [
            {
                question: createPlanApprovalQuestion(planLabel),
                header: CREATE_PLAN_APPROVAL_HEADER,
                options: [
                    {
                        label: CREATE_PLAN_APPROVAL_YES,
                        description: "Switch to build agent and start implementing the plan",
                    },
                    {
                        label: CREATE_PLAN_APPROVAL_NO,
                        description: "Stay with plan agent to continue refining the plan",
                    },
                ],
            },
        ],
    };
}
/**
 * True when the emulated approval prompt came back as an explicit "Yes".
 * An unanswered, dismissed, or failed prompt keeps the model planning.
 */
export function createPlanApproved(output, isError, question) {
    if (isError)
        return false;
    const [segment] = parseAnswerSegments([createPlanApprovalItem(question)], output);
    return (segment ?? "").trim().toLowerCase() === CREATE_PLAN_APPROVAL_YES.toLowerCase();
}
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function str(value) {
    return typeof value === "string" ? value : "";
}
function mapTodoStatus(status) {
    if (typeof status === "string")
        return status.toLowerCase();
    if (typeof status === "number") {
        // TodoStatus enum: PENDING=1, IN_PROGRESS=2, COMPLETED=3, CANCELLED=4
        switch (status) {
            case 2:
                return "in_progress";
            case 3:
                return "completed";
            case 4:
                return "cancelled";
            default:
                return "pending";
        }
    }
    return "pending";
}
function todoCheckbox(status) {
    const s = status.toLowerCase();
    if (s === "completed" || s === "complete" || s === "done")
        return "[x]";
    if (s === "cancelled" || s === "canceled")
        return "[~]";
    return "[ ]";
}
/** Decode a `create_plan_request_query` body, or undefined when unusable. */
export function decodeCreatePlanQuery(queryBytes) {
    let decoded;
    try {
        decoded = decodeMessageSparse("CreatePlanRequestQuery", queryBytes);
    }
    catch {
        return undefined;
    }
    const args = asRecord(decoded.args);
    if (!args)
        return undefined;
    const plan = str(args.plan);
    const overview = str(args.overview);
    const name = str(args.name);
    const todos = Array.isArray(args.todos)
        ? args.todos.flatMap((raw) => {
            const item = asRecord(raw);
            if (!item)
                return [];
            const content = str(item.content);
            if (!content)
                return [];
            return [
                {
                    id: str(item.id),
                    content,
                    status: mapTodoStatus(item.status),
                },
            ];
        })
        : [];
    // Empty args: CLI acknowledges with empty plan_uri; treat as no write.
    if (!plan && !overview && !name && todos.length === 0)
        return undefined;
    return {
        args: {
            plan,
            overview,
            name,
            isProject: args.is_project === true,
            todos,
        },
        toolCallId: str(decoded.tool_call_id),
    };
}
/** OpenCode-style adjective-noun slug (core/src/util/slug.ts). */
export function randomPlanSlug(seed = Date.now()) {
    const adj = PLAN_ADJECTIVES[seed % PLAN_ADJECTIVES.length];
    const noun = PLAN_NOUNS[Math.floor(seed / PLAN_ADJECTIVES.length) % PLAN_NOUNS.length];
    return `${adj}-${noun}`;
}
/** Slugify a human title into a filesystem-safe token. */
export function slugifyPlanName(name) {
    const slug = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
    return slug || randomPlanSlug();
}
/** Build the advertised host plan-stage artifact payload. */
export function createPlanStageInput(args) {
    const slug = slugifyPlanName(args.name);
    return {
        plan_uri: `local://${slug}-plan.md`,
        content: renderOpencodePlanMarkdown(args),
        title: slug,
    };
}
/**
 * Resolve the absolute plan file path via {@link hostPlansDir}.
 * Filename shape matches OpenCode Session.plan: `<created>-<slug>.md`.
 */
export function resolveHostPlanPath(workspaceRoot, name, created = Date.now()) {
    const slug = name?.trim() ? slugifyPlanName(name) : randomPlanSlug(created);
    return path.join(hostPlansDir(workspaceRoot), `${created}-${slug}.md`);
}
/** @deprecated Prefer {@link resolveHostPlanPath}. */
export const resolveOpencodePlanPath = resolveHostPlanPath;
/**
 * Render plain markdown for the plan file. No Cursor YAML frontmatter.
 * Prefer `args.plan` as the body; prepend a title/overview when useful; append
 * a markdown checklist for todos.
 */
export function renderOpencodePlanMarkdown(args) {
    const parts = [];
    const name = args.name.trim();
    const overview = args.overview.trim();
    const plan = args.plan.trim();
    // Cursor usually repeats the plan name as the body's own leading H1. Strip it
    // so the document keeps one title in the right place instead of opening with
    // the same heading twice (or with the overview stranded above it).
    const planLeadHeading = /^#\s+(.+?)\s*$/.exec(plan.split("\n", 1)[0] ?? "")?.[1];
    const planBody = name
        && planLeadHeading !== undefined
        && planLeadHeading.trim().toLowerCase() === name.toLowerCase()
        ? plan.slice(plan.indexOf("\n") + 1).trimStart()
        : plan;
    if (name) {
        parts.push(`# ${name}`);
        parts.push("");
    }
    if (overview) {
        // Avoid duplicating overview when it already leads the plan body.
        if (!planBody || !planBody.startsWith(overview)) {
            parts.push(overview);
            parts.push("");
        }
    }
    if (planBody) {
        parts.push(planBody);
        if (!planBody.endsWith("\n"))
            parts.push("");
    }
    if (args.todos.length > 0) {
        if (parts.length > 0 && parts[parts.length - 1] !== "")
            parts.push("");
        parts.push("## Todos");
        parts.push("");
        for (const todo of args.todos) {
            parts.push(`- ${todoCheckbox(todo.status)} ${todo.content}`);
        }
        parts.push("");
    }
    const body = parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
    return body ? `${body}\n` : "";
}
/**
 * Write the plan under {@link hostPlansDir} and return a `file://` URI.
 * Empty / missing content is the caller's responsibility (empty plan_uri ack).
 */
export function writeOpencodePlanFile(args, workspaceRoot, created = Date.now(), 
/** Exact host-owned plan file; default is a new file under {@link hostPlansDir}. */
target) {
    const markdown = renderOpencodePlanMarkdown(args);
    if (!markdown.trim()) {
        return { ok: false, error: "CreatePlan produced no plan content to write" };
    }
    const planPath = target ?? resolveHostPlanPath(workspaceRoot, args.name, created);
    try {
        mkdirSync(path.dirname(planPath), { recursive: true });
        writeFileSync(planPath, markdown, "utf-8");
    }
    catch (err) {
        const message = errorMessage(err);
        return { ok: false, error: `Failed to write plan file: ${message}` };
    }
    return {
        ok: true,
        planPath,
        planUri: pathToFileURL(planPath).href,
        markdown,
    };
}
/**
 * The plan as the user reads it before approving execution.
 *
 * Cursor routes the plan body through the interaction query rather than the
 * text stream, so without this the user is asked to approve a plan they were
 * never shown. It goes into the assistant message — the host renders markdown
 * there, it scrolls, and it survives answering the prompt. It must not go into
 * the question itself: OpenCode renders the question dock outside its
 * scrollbox with `flexShrink={0}`, so a full plan there would push the
 * conversation off screen.
 */
export function renderPlanReviewMessage(markdown, planPath) {
    const body = markdown.trim();
    const saved = `_Plan saved to ${planPath}_`;
    return body ? `${body}\n\n${saved}\n` : `${saved}\n`;
}
