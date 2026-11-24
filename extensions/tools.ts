// tools
//
// /tools lists every registered tool, active then inactive, grouped by where it comes from:
// "builtin", an MCP namespace, or the extension's name.
// List only. Change the selection with --tools, --exclude-tools or the defaultTools setting.
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { basename, dirname } from "node:path";

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
