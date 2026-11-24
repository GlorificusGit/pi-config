// tools
//
// /tools lists every registered tool, active then inactive, grouped by where it comes from:
// "builtin", an MCP namespace, or the extension's name.
// List only. Change the selection with --tools, --exclude-tools or the defaultTools setting.
//
// A new session also starts with a [Tools] entry naming the active tools, below pi's startup listing.
// It is saved in the session but never sent to the model. Hidden when quietStartup is set.
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { basename, dirname } from "node:path";

const ENTRY = "tools-startup";

function sourceLabel(tool: ToolInfo): string {
  if (tool.namespace) return tool.namespace.name;
  const { path } = tool.sourceInfo;
  if (path.startsWith("builtin:")) return "builtin";
  const file = basename(path).replace(/\.[cm]?[jt]s$/, "");
  return file === "index" ? basename(dirname(path)) : file;
}

function section(title: string, tools: ToolInfo[], width: number): string[] {
  if (tools.length === 0) return [];
  const groups = new Map<string, string[]>();
  for (const t of tools) {
    const label = sourceLabel(t);
    groups.set(label, [...(groups.get(label) ?? []), t.name]);
  }
  return [title, ...[...groups].map(([label, names]) => `  ${label.padEnd(width)}  ${names.join(", ")}`)];
}

export default function (pi: ExtensionAPI) {
  pi.registerEntryRenderer<string[]>(ENTRY, (entry, _options, theme) =>
    new Text(`${theme.fg("mdHeading", "[Tools]")}\n${theme.fg("dim", `  ${(entry.data ?? []).join(", ")}`)}`, 0, 0),
  );

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI || pi.getSettings().quietStartup) return;
    // New sessions only: skip resumed ones and a reload of this one.
    const started = ctx.sessionManager
      .getEntries()
      .some((e) => e.type === "message" || (e.type === "custom" && e.customType === ENTRY));
    if (!started) pi.appendEntry(ENTRY, pi.getActiveTools());
  });

  pi.registerCommand("tools", {
    description: "List active and inactive tools",
    handler: async (_args, ctx) => {
      const active = new Set(pi.getActiveTools());
      const all = pi.getAllTools();
      const width = Math.max(0, ...all.map((t) => sourceLabel(t).length));
      const lines = [
        ...section("active", all.filter((t) => active.has(t.name)), width),
        ...section("inactive", all.filter((t) => !active.has(t.name)), width),
      ];
      ctx.ui.notify(lines.join("\n") || "no tools registered", "info");
    },
  });
}
