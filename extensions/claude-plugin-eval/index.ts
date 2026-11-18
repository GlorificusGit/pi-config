/**
 * claude-plugin-eval
 *
 * Runs Claude-format skill evals (`claude plugin eval` suites) against pi. See runner.ts for the
 * flags, the run model and the output layout.
 *
 *   /claude-plugin-eval [run] [skill-dir] [flags]
 *   /claude-plugin-eval trigger <eval-set.json> [skill-dir] [flags]
 *   /claude-plugin-eval optimize <eval-set.json> [skill-dir] [flags]
 *
 * The skill dir defaults to the session cwd. Progress shows in the footer status; the result is
 * posted to the session (visible to the model, no turn is started). The same runner works as a CLI:
 *
 *   bun extensions/claude-plugin-eval/runner.ts run path/to/skill --runs 1
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { run } from "./runner.ts";

const NAME = "claude-plugin-eval";

/** Split like a shell: whitespace separates, single or double quotes group. */
const split = (s: string) => [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

export default function (pi: ExtensionAPI): void {
  pi.registerCommand(NAME, {
    description: "Run Claude-format skill evals against pi: [run|trigger|optimize] [skill-dir] [flags]",
    handler: async (args, ctx) => {
      const out: string[] = [];
      const io = { log: (l: string) => ctx.ui.setStatus(NAME, l), out: (t: string) => out.push(t) };
      let code: number;
      try {
        code = await run(split(args), io, ctx.cwd, ctx.signal);
      } catch (err) {
        out.push(err instanceof Error ? err.message : String(err));
        code = 1;
      } finally {
        ctx.ui.setStatus(NAME, undefined);
      }
      pi.sendMessage({ customType: NAME, content: `${NAME} ${args} (exit ${code})\n\n${out.join("\n")}`, display: true });
    },
  });
}
