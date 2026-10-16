import { describe, expect, it } from "vite-plus/test";
import {
  replaceHomeDirWithTilde,
  replaceHomeDirWithTildeInDocument,
} from "../src/lib/home-dir-display.js";
import type { ReportDocument } from "../src/lib/report-document.js";

const HOME = "/Users/alice";

describe("replaceHomeDirWithTilde", () => {
  it("shows a path under home as ~/...", () => {
    expect(replaceHomeDirWithTilde("/Users/alice/.local/share/opencode/opencode.db", HOME)).toBe(
      "~/.local/share/opencode/opencode.db",
    );
  });

  it("shows the home dir itself as ~", () => {
    expect(replaceHomeDirWithTilde("/Users/alice", HOME)).toBe("~");
    expect(replaceHomeDirWithTilde("cwd=/Users/alice present=true", HOME)).toBe(
      "cwd=~ present=true",
    );
  });

  it("replaces every home path inside a longer line", () => {
    expect(
      replaceHomeDirWithTilde(
        "path=/Users/alice/a.json present=true | /Users/alice/.config/b.json (/Users/alice/c)",
        HOME,
      ),
    ).toBe("path=~/a.json present=true | ~/.config/b.json (~/c)");
  });

  it("leaves a lookalike folder that only starts with the home name alone", () => {
    expect(replaceHomeDirWithTilde("/Users/alicesmith/.config/opencode", HOME)).toBe(
      "/Users/alicesmith/.config/opencode",
    );
    expect(replaceHomeDirWithTilde("/Users/alice.old/x", HOME)).toBe("/Users/alice.old/x");
  });

  it("leaves a path outside home unchanged", () => {
    expect(replaceHomeDirWithTilde("/tmp/opencode/opencode.db", HOME)).toBe(
      "/tmp/opencode/opencode.db",
    );
    expect(replaceHomeDirWithTilde("/mnt/backup/Users/alice/x", HOME)).toBe(
      "/mnt/backup/Users/alice/x",
    );
  });

  it("leaves a home-like folder deeper inside another path alone, including non-ASCII", () => {
    expect(replaceHomeDirWithTilde("/mnt/备份/Users/alice/project", HOME)).toBe(
      "/mnt/备份/Users/alice/project",
    );
    expect(replaceHomeDirWithTilde("/mnt/backup-/Users/alice/project", HOME)).toBe(
      "/mnt/backup-/Users/alice/project",
    );
  });

  it("replaces home after the delimiters the report puts before paths", () => {
    expect(
      replaceHomeDirWithTilde(
        "a=/Users/alice/1 (/Users/alice/2) [/Users/alice/3] '/Users/alice/4' `/Users/alice/5` x:/Users/alice/6,/Users/alice/7",
        HOME,
      ),
    ).toBe("a=~/1 (~/2) [~/3] '~/4' `~/5` x:~/6,~/7");
  });

  it("treats a space after home as the end of the home path (known trade-off)", () => {
    expect(replaceHomeDirWithTilde("not found at /Users/alice is missing", HOME)).toBe(
      "not found at ~ is missing",
    );
    expect(replaceHomeDirWithTilde("/Users/alice backup/project", HOME)).toBe("~ backup/project");
  });

  it("ignores a trailing separator on the home dir", () => {
    expect(replaceHomeDirWithTilde("/home/bob/.config", "/home/bob/")).toBe("~/.config");
  });

  it("handles a Windows home dir", () => {
    expect(
      replaceHomeDirWithTilde(
        "path=C:\\Users\\alice\\.local\\share\\opencode\\opencode.db",
        "C:\\Users\\alice",
      ),
    ).toBe("path=~\\.local\\share\\opencode\\opencode.db");
    expect(replaceHomeDirWithTilde("C:\\Users\\alicesmith\\x", "C:\\Users\\alice")).toBe(
      "C:\\Users\\alicesmith\\x",
    );
  });

  it("handles a JSON-escaped Windows home (doubled backslashes)", () => {
    const quoted = JSON.stringify("C:\\Users\\Alice Smith\\.local\\bin\\claude");
    expect(replaceHomeDirWithTilde(`${quoted} --version`, "C:\\Users\\Alice Smith")).toBe(
      '"~\\\\.local\\\\bin\\\\claude" --version',
    );
  });

  it.each([
    ["\\\\?\\C:\\Users\\Name\\x", "~\\x"],
    ["path=\\\\.\\C:\\Users\\Name\\x", "path=~\\x"],
    ["//?/c:/users/name/x", "~/x"],
    [JSON.stringify("\\\\?\\C:\\Users\\Name\\x"), '"~\\\\x"'],
  ])("handles a Windows device path to the home dir: %s", (text, shown) => {
    expect(replaceHomeDirWithTilde(text, "C:\\Users\\Name")).toBe(shown);
  });

  it("does nothing when the home dir is empty or a filesystem root", () => {
    expect(replaceHomeDirWithTilde("/etc/hosts", "/")).toBe("/etc/hosts");
    expect(replaceHomeDirWithTilde("/etc/hosts", "")).toBe("/etc/hosts");
    expect(replaceHomeDirWithTilde("C:\\x", "C:\\")).toBe("C:\\x");
  });
});

describe("replaceHomeDirWithTildeInDocument", () => {
  it("replaces the home dir in every kind of block", () => {
    const document: ReportDocument = {
      heading: "# /Users/alice/title",
      sections: [
        {
          id: "s",
          title: "paths:",
          blocks: [
            {
              kind: "lines",
              lines: ["- configPaths: /Users/alice/.config/opencode/opencode.json"],
            },
            { kind: "kv", rows: [{ key: "opencode.db", value: "path=/Users/alice/x.db" }] },
          ],
        },
      ],
    };

    expect(replaceHomeDirWithTildeInDocument(document, HOME)).toEqual({
      heading: "# ~/title",
      sections: [
        {
          id: "s",
          title: "paths:",
          blocks: [
            { kind: "lines", lines: ["- configPaths: ~/.config/opencode/opencode.json"] },
            { kind: "kv", rows: [{ key: "opencode.db", value: "path=~/x.db" }] },
          ],
        },
      ],
    });
  });

  it("keeps the document a plain JSON value, with no optional field set to undefined", () => {
    // OpenCode only accepts JSON values in a command result; an `undefined` field is rejected.
    const document: ReportDocument = {
      sections: [
        {
          id: "s",
          blocks: [{ kind: "kv", rows: [{ key: "/Users/alice/a" }] }],
        },
      ],
    };

    const result = replaceHomeDirWithTildeInDocument(document, HOME);
    expect(result).toStrictEqual(JSON.parse(JSON.stringify(result)));
    expect(JSON.stringify(result)).not.toContain("alice");
  });
});
