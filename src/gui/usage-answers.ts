/**
 * The usage window's reports for Cost and Tokens: it asks the server whenever the question
 * changes; while a new one loads, the last stays, and an answer to an older question is dropped.
 */
import { createSignal } from "solid-js";
import type { UsageQuery, UsageReport } from "../core/usage.js";
import { rpcErrorMessage } from "../tui/client.js";
import type { GuiQuota } from "./bridge.js";
import type { UsageScope, WindowRange } from "./usage-model.js";

/** The range and sessions a report was asked for (its label). */
export type Asking = { range: WindowRange; scope: UsageScope };
/** The last report, with the range and sessions it was asked for. */
export type Answered = Asking & { report: UsageReport };
export type UsageState = { answered?: Answered; loading: boolean; error?: string };

export function createUsageAnswers(data: Pick<GuiQuota, "usage">) {
  const [usage, setUsage] = createSignal<UsageState>({ loading: false });
  // Numbers every question, so an answer to an older one is dropped.
  let asked = 0;
  return {
    usage,
    /**
     * Asks `query` for `directory`. No query (Limits, or one Cost can't ask) is a question too:
     * the answer still coming drops, and the last report stays.
     */
    ask(query: UsageQuery | undefined, directory: string | undefined, asking: Asking): void {
      if (!query) {
        asked += 1;
        setUsage((previous) => (previous.loading ? { ...previous, loading: false } : previous));
        return;
      }
      const call = ++asked;
      setUsage((previous) => ({ answered: previous.answered, loading: true }));
      data.usage(query, directory).then(
        (report) => {
          if (call === asked) setUsage({ answered: { report, ...asking }, loading: false });
        },
        (error: unknown) => {
          if (call === asked) setUsage({ loading: false, error: rpcErrorMessage(error) });
        },
      );
    },
    /** Drops the answer still coming: the window closed. */
    stop(): void {
      asked += 1;
    },
  };
}
