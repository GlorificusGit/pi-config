#!/usr/bin/env bun
/**
 * claude-plugin-eval runner: Claude-format skill evals against pi.
 *
 * Mirrors `claude plugin eval` for one skill. Cases live in
 * `<skill>/evals/<case>/{prompt.md, case.yaml, graders/*.md, files/}`.
 *
 *   bun runner.ts [run] [skill-dir] [flags]          behavior evals (default)
 *   bun runner.ts trigger <eval-set.json> [skill-dir] trigger rate (pi-skill-creator run_eval.py)
 *   bun runner.ts optimize <eval-set.json> [skill-dir] description loop (pi-skill-creator run_loop.py)
 *
 * Flags: --case <glob>, --tag <tag> (repeat or comma list), --runs <n> (default case.runs ?? 3),
 * -j/--concurrency <n> (default 1), --model, --judge-model (default: pi's default model),
 * --allow-tools <list> (grants Bash, Write, Edit), --scaffold, --threshold <0..1> (default 1),
 * --json [path], --output-dir <dir> (default <skill>/evals/results/<timestamp>).
 *
 * How a run works:
 * - Every child pi runs with an isolated PI_CODING_AGENT_DIR (auth, models and default model of the
 *   current profile; no packages, skills or context files) in a temp sandbox cwd.
 * - Each case runs `--runs` times per arm: with_skill (`--no-skills --skill <dir>`) and without_skill
 *   (`--no-skills`). Graders marked `arm: with-only`, and `tool_used: Skill` without `arm`, only
 *   score the with_skill arm when other graders exist.
 * - pi tools stand in for Claude's: Read→read, Write→write, Edit→edit, Bash→bash, Grep→grep, Glob→find,
 *   LS→ls. The trace reports them under the Claude names, and a read of a SKILL.md also counts as a
 *   `Skill` call. Bash, Write and Edit need --allow-tools as well as `allowed_tools`.
 * - regex, file_exists, tool_used and tool_order grade in code; llm and baseline take three pi judge votes.
 * - `max_turns` and `timeout_seconds` kill the child. Results use the pi-skill-creator workspace layout
 *   (`<case>/<arm>/run-N/{outputs/, grading.json, timing.json, transcript.jsonl}`), then
 *   aggregate_benchmark.py, an analyzer.md pass and `generate_review.py --static` produce
 *   benchmark.json/md and review.html. The full result goes to aggregate-result.json.
 *
 * Exit code 1 when a case fails to load or a with_skill score is below --threshold.
 * Not supported: MCP mocks, history_file, add_dirs, publishing reports.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse as yaml } from "yaml";

export interface Io {
  /** Progress line. */
  log(line: string): void;
  /** Final result text. */
  out(text: string): void;
}

type Arm = "with_skill" | "without_skill";
type Focus = "last_message" | "trace" | "files" | "mock_calls" | { source: "file"; path: string };
type Json = Record<string, any>;

interface ToolRef { tool: string; input_match?: string }
interface Grader {
  name: string; type: string; weight: number; arm?: "with-only" | "both";
  criteria?: string; focus?: Focus; baseline_file?: string;
  pattern?: string; flags?: string; match?: string; target?: Focus;
  tool?: string; input_match?: string; min?: number; max?: number;
  before?: ToolRef; after?: ToolRef; path?: string; exists?: boolean;
}
interface Case {
  name: string; dir: string; tags: string[]; runs: number; prompt: string; maxTurns: number; timeout: number;
  model?: string; tools: string[]; disallowed: string[]; append?: string; env: Record<string, string>;
  scaffold?: string; graders: Grader[];
}
interface Call { name: string; input: unknown; inputText: string; isError?: boolean }
interface Run { sandbox: string; calls: Call[]; trace: Json[]; last: string; diff: string[]; tokens: number; cost: number; ms: number; error?: string; ungraded?: boolean }
interface Verdict { name: string; text: string; weight: number; scored: boolean; passed: boolean; explanation: string }
interface Ctx {
  skill: string; name: string; out: string; profile: string; io: Io; signal?: AbortSignal;
  model?: string; judgeModel?: string; granted: Set<string>; scaffold: boolean;
}

const CREATOR = resolve(dirname(fileURLToPath(import.meta.url)), "../../skills/pi-skill-creator");
const ARMS: Arm[] = ["with_skill", "without_skill"];
const RESERVED = new Set(["results", "mocks", "node_modules", "files"]);
const TOP = new Set(["schema_version", "name", "description", "tags", "plugins", "runs", "expected_outcome"]);
const EXEC = new Set(["model", "max_turns", "timeout_seconds", "allowed_tools", "disallowed_tools", "artifact_publish", "growthbook_overrides", "append_system_prompt", "env"]);
const TYPES = new Set(["regex", "tool_order", "tool_used", "file_exists", "llm", "baseline"]);
const BODY_KEY: Record<string, string> = { llm: "criteria", baseline: "criteria", regex: "pattern" };
const PI_TOOL: Record<string, string> = { Read: "read", Write: "write", Edit: "edit", Bash: "bash", Grep: "grep", Glob: "find", LS: "ls", Skill: "read" };
const CLAUDE_TOOL = Object.fromEntries(Object.entries(PI_TOOL).filter(([k]) => k !== "Skill").map(([k, v]) => [v, k]));
const GATED = new Set(["Bash", "Write", "Edit", "WebFetch"]);
const DEFAULT_TOOLS = ["Read", "Glob", "Grep", "Skill"];
const JUDGE = "You are a strict, terse evaluation judge for coding-agent traces.";
const VERDICT = "Respond with exactly one word: PASS or FAIL.";

const USAGE = `usage: claude-plugin-eval [run|trigger <eval-set.json>|optimize <eval-set.json>] [skill-dir]
  --case <glob>  --tag <tags>  --runs <n>  -j <n>  --model <m>  --judge-model <m>
  --allow-tools <tools>  --scaffold  --threshold <0..1>  --json [path]  --output-dir <dir>`;

const cli: Io = { log: (l) => console.error(l), out: (t) => console.log(t) };
const j = (v: unknown) => JSON.stringify(v);
const opt = (flag: string, v?: string) => (v ? [flag, v] : []);
const list = (v?: string[]) => (v ?? []).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const toolName = (t: string) => CLAUDE_TOOL[t] ?? t.replace(/\(.*\)$/, "").trim();

/** Claude's glob: `**\/` any dirs, `**` anything, `*` within a segment, `?` one char. */
function globRe(g: string): RegExp {
  let re = "^";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      re += g[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += g[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += ".";
    else re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`${re}$`);
}

function frontmatter(text: string): { fm: Json; body: string; has: boolean } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return m ? { fm: yaml(m[1]) ?? {}, body: text.slice(m[0].length), has: true } : { fm: {}, body: text, has: false };
}

interface ExecOpts {
  cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number; signal?: AbortSignal;
  onOut?: (line: string, kill: () => void) => void; onErr?: (line: string) => void;
}

/** Spawn a process, feed stdin, and collect output, optionally line by line (LF only, as pi's JSONL requires). */
function exec(cmd: string, args: string[], o: ExecOpts = {}): Promise<{ code: number | null; sig: string | null; out: string; err: string }> {
  return new Promise((done) => {
    const p = spawn(cmd, args, { cwd: o.cwd, env: o.env, signal: o.signal, timeout: o.timeout });
    const kill = () => p.kill();
    const res = { out: "", err: "" };
    const collect = (key: "out" | "err", fn?: (line: string) => void) => {
      let buf = "";
      return (d: string) => {
        res[key] += d;
        if (!fn) return;
        buf += d;
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const l of lines) fn(l.replace(/\r$/, ""));
      };
    };
    p.stdout.setEncoding("utf8").on("data", collect("out", o.onOut && ((l) => o.onOut!(l, kill))));
    p.stderr.setEncoding("utf8").on("data", collect("err", o.onErr));
    p.stdin.on("error", () => {});
    p.stdin.end(o.input ?? "");
    p.on("error", (e) => done({ code: -1, sig: null, out: res.out, err: res.err + e.message }));
    p.on("close", (code, sig) => done({ code, sig, ...res }));
  });
}

/** Isolated pi profile: the current profile's auth, models and default model, nothing else. */
async function makeProfile(): Promise<string> {
  const src = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi/agent");
  const dst = await mkdtemp(join(tmpdir(), "cpe-profile-"));
  for (const f of ["auth.json", "models.json"]) if (existsSync(join(src, f))) await symlink(join(src, f), join(dst, f));
  const s: Json = JSON.parse(await readFile(join(src, "settings.json"), "utf8").catch(() => "{}"));
  const keep = ["defaultProvider", "defaultModel", "defaultThinkingLevel"];
  await writeFile(join(dst, "settings.json"), j(Object.fromEntries(keep.filter((k) => k in s).map((k) => [k, s[k]]))));
  return dst;
}

const env = (ctx: Ctx, extra: Record<string, string> = {}) => ({ ...process.env, ...extra, PI_CODING_AGENT_DIR: ctx.profile });

async function loadCase(dir: string): Promise<Case | null> {
  const read = (f: string) => readFile(join(dir, f), "utf8").catch(() => null);
  const [yml, md] = await Promise.all([read("case.yaml"), read("prompt.md")]);
  const gdir = join(dir, "graders");
  const gfiles = existsSync(gdir) ? (await readdir(gdir)).filter((f) => f.endsWith(".md")).sort() : [];
  if (yml === null && md === null && !gfiles.length) return null;

  const c: Json = (yml && yaml(yml)) || {};
  const ex: Json = { ...c.execution };
  if (md !== null) {
    const { fm, body } = frontmatter(md);
    for (const [k, v] of Object.entries(fm)) {
      if (TOP.has(k)) c[k] = v;
      else if (EXEC.has(k)) ex[k] = v;
      else throw new Error(`prompt.md: unknown frontmatter key "${k}"`);
    }
    if (body.trim()) ex.prompt = body.trim();
  }
  const graders: Json[] = [...(c.graders ?? [])];
  for (const f of gfiles) {
    const { fm, body, has } = frontmatter(await readFile(join(gdir, f), "utf8"));
    if (!has) continue;
    if (typeof fm.type !== "string") throw new Error(`graders/${f}: frontmatter must include "type:"`);
    const g: Json = { name: basename(f, ".md"), ...fm };
    const key = BODY_KEY[fm.type];
    if (key && g[key] === undefined && body.trim()) g[key] = body.trim();
    graders.push(g);
  }

  if (!ex.prompt) throw new Error("no prompt (prompt.md body or execution.prompt)");
  if (!graders.length) throw new Error("no graders");
  const names = new Set<string>();
  const ref = (r: string | ToolRef): ToolRef => (typeof r === "string" ? { tool: toolName(r) } : { ...r, tool: toolName(r.tool) });
  return {
    name: c.name ?? basename(dir), dir, tags: c.tags ?? [], runs: c.runs ?? 3, prompt: ex.prompt,
    maxTurns: ex.max_turns ?? 10, timeout: ex.timeout_seconds ?? 300, model: ex.model,
    tools: ex.allowed_tools?.length ? ex.allowed_tools : DEFAULT_TOOLS, disallowed: ex.disallowed_tools ?? [],
    append: ex.append_system_prompt, env: ex.env ?? {}, scaffold: c.context?.scaffold_script,
    graders: graders.map((g) => {
      if (!TYPES.has(g.type)) throw new Error(`grader "${g.name}": unknown type "${g.type}"`);
      if (names.has(g.name)) throw new Error(`duplicate grader name "${g.name}"`);
      names.add(g.name);
      return {
        weight: 1, target: "last_message", focus: "last_message", flags: "", match: "contains", exists: true, ...g,
        ...(g.tool && { tool: toolName(g.tool) }), ...(g.before && { before: ref(g.before) }), ...(g.after && { after: ref(g.after) }),
      } as Grader;
    }),
  };
}

async function loadCases(skill: string, glob?: string, tags: string[] = []): Promise<{ cases: Case[]; errors: string[] }> {
  const root = join(skill, "evals");
  const dirs = existsSync(root) ? (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && !RESERVED.has(d.name)) : [];
  const cases: Case[] = [];
  const errors: string[] = [];
  for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const c = await loadCase(join(root, d.name));
      if (c && (!glob || globRe(glob).test(c.name)) && (!tags.length || c.tags.some((t) => tags.includes(t)))) cases.push(c);
    } catch (e) {
      errors.push(`${d.name}: ${(e as Error).message}`);
    }
  }
  return { cases, errors };
}

/** pi tool allowlist for a case: mapped Claude names, gated tools only when granted. */
function piTools(c: Case, granted: Set<string>): string[] {
  const off = new Set(c.disallowed.map(toolName));
  const names = c.tools.map(toolName).filter((t) => !off.has(t) && (!GATED.has(t) || granted.has(t)));
  return [...new Set(names.map((t) => PI_TOOL[t]).filter(Boolean))];
}

async function snapshot(dir: string): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath, e.name);
    const s = await stat(p);
    m.set(p.slice(dir.length + 1), `${s.size}:${s.mtimeMs}`);
  }
  return m;
}

const textOf = (content: unknown) =>
  Array.isArray(content) ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : String(content ?? "");

/** One child pi run of a case in a fresh sandbox; returns its normalized trace. */
async function execute(c: Case, arm: Arm, ctx: Ctx, events: Json[]): Promise<Run> {
  const sandbox = await mkdtemp(join(tmpdir(), "cpe-run-"));
  const run: Run = { sandbox, calls: [], trace: [], last: "", diff: [], tokens: 0, cost: 0, ms: 0 };
  if (c.scaffold && ctx.scaffold) {
    const s = await exec("bash", [join(c.dir, c.scaffold)], { cwd: sandbox, signal: ctx.signal });
    if (s.code !== 0) return { ...run, error: `scaffold failed: ${s.err.trim().split("\n").pop() || `exit ${s.code ?? s.sig}`}`, ungraded: true };
  }
  const before = await snapshot(sandbox);
  const tools = piTools(c, ctx.granted);
  const args = [
    "-p", "--mode", "json", "--no-session", "--no-skills", ...(arm === "with_skill" ? ["--skill", join(ctx.skill, "SKILL.md")] : []),
    ...(tools.length ? ["--tools", tools.join(",")] : ["--no-tools"]),
    ...opt("--model", ctx.model ?? c.model), ...opt("--append-system-prompt", c.append),
  ];
  const byId = new Map<string, Call>();
  let turns = 0;
  const t0 = Date.now();

  const r = await exec("pi", args, {
    cwd: sandbox, env: env(ctx, c.env), input: c.prompt, timeout: c.timeout * 1000, signal: ctx.signal,
    onOut: (line, kill) => {
      let e: Json;
      try { e = JSON.parse(line); } catch { return; }
      if (e.type !== "message_update") events.push(e);
      if (e.type === "turn_start" && ++turns > c.maxTurns) {
        run.error = `max_turns (${c.maxTurns}) reached`;
        kill();
      } else if (e.type === "tool_execution_start") {
        const call: Call = { name: toolName(e.toolName), input: e.args, inputText: j(e.args) };
        const path = String(e.toolName === "read" ? e.args?.path ?? "" : "");
        if (basename(path) === "SKILL.md") {
          const skill = { skill: basename(dirname(resolve(sandbox, path))) };
          run.calls.push({ name: "Skill", input: skill, inputText: j(skill) });
        }
        run.calls.push(call);
        byId.set(e.toolCallId, call);
      } else if (e.type === "tool_execution_end") {
        const call = byId.get(e.toolCallId);
        if (call) call.isError = e.isError;
        run.trace.push({ tool: call?.name ?? e.toolName, input: call?.input, output: textOf(e.result?.content), ...(e.isError && { isError: true }) });
      } else if (e.type === "message_end" && e.message?.role === "assistant") {
        const m = e.message;
        run.tokens += m.usage?.totalTokens ?? 0;
        run.cost += m.usage?.cost?.total ?? 0;
        const text = textOf(m.content);
        if (text) {
          run.trace.push({ role: "assistant", text });
          run.last = text;
        }
        if (m.stopReason === "error") run.error = m.errorMessage ?? "model error";
      }
    },
  });
  run.ms = Date.now() - t0;
  if (!run.error && r.sig) run.error = ctx.signal?.aborted ? "aborted" : `timed out after ${c.timeout}s`;
  if (!run.error && r.code) run.error = r.err.trim().split("\n").pop() || `pi exited ${r.code}`;
  const after = await snapshot(sandbox);
  run.diff = [...after.keys()].filter((k) => after.get(k) !== before.get(k));
  return run;
}

/** Text a regex or llm grader looks at. */
async function source(f: Focus, run: Run): Promise<string> {
  if (typeof f === "object") {
    const p = resolve(run.sandbox, f.path);
    if (!p.startsWith(run.sandbox + sep)) throw new Error(`focus file ${f.path} leaves the run directory`);
    return readFile(p, "utf8").catch(() => { throw new Error(`focus file ${f.path} does not exist`); });
  }
  if (f === "last_message") return run.last;
  if (f === "files") return run.diff.join("\n");
  if (f === "trace") return run.trace.map(j).join("\n");
  throw new Error(`${f} is not supported (no MCP mocks)`);
}

const label = (f: Focus) => (typeof f === "object" ? `file ${f.path}` : f);
const elide = (t: Json[]) => (t.length <= 24 ? t.map(j) : [...t.slice(0, 12).map(j), `[…${t.length - 24} messages elided…]`, ...t.slice(-12).map(j)]).join("\n");
const clip = (s: string, head = 80000, tail = 20000) => (s.length <= head + tail ? s : `${s.slice(0, head)}\n[…${s.length - head - tail} chars elided…]\n${s.slice(-tail)}`);
const matches = (call: Call, r: ToolRef) => call.name === r.tool && (!r.input_match || new RegExp(r.input_match).test(call.inputText));

/** Three judge votes through pi; passes on a majority. */
async function judge(prompt: string, ctx: Ctx): Promise<{ passed: boolean; explanation: string }> {
  const args = ["-p", "--no-session", "--no-tools", "--no-skills", "--no-extensions", "--no-context-files", "--system-prompt", JUDGE, ...opt("--model", ctx.judgeModel)];
  const votes = await Promise.all([0, 1, 2].map(async () => {
    const r = await exec("pi", args, { cwd: tmpdir(), env: env(ctx), input: prompt, signal: ctx.signal });
    if (r.code) throw new Error(`judge call failed: ${r.err.trim()}`);
    return /\bPASS\b/i.test(r.out) && !/\bFAIL\b/i.test(r.out);
  }));
  return { passed: votes.filter(Boolean).length > 1, explanation: `judge votes: ${votes.map((v) => (v ? "PASS" : "FAIL")).join(" ")}` };
}

async function grade(g: Grader, run: Run, c: Case, ctx: Ctx): Promise<{ passed: boolean; explanation: string }> {
  const fail = (explanation: string) => ({ passed: false, explanation });
  switch (g.type) {
    case "regex": {
      const text = await source(g.target!, run);
      const n = text.match(new RegExp(g.pattern!, g.flags!.includes("g") ? g.flags : `${g.flags}g`))?.length ?? 0;
      if (g.match === "contains") return n ? { passed: true, explanation: `matched ${g.pattern}` } : fail(`pattern not found in ${label(g.target!)}`);
      if (g.match === "not_contains") return n ? fail("pattern found (expected absent)") : { passed: true, explanation: "pattern absent as expected" };
      const want = Number(g.match!.slice(6));
      return { passed: n === want, explanation: `found ${n} matches (expected ${want})` };
    }
    case "tool_order": {
      const [b, a] = [g.before!, g.after!].map((r) => run.calls.findIndex((call) => matches(call, r)));
      if (b === -1) return fail(`"before" tool ${g.before!.tool} never called`);
      if (a === -1) return fail(`"after" tool ${g.after!.tool} never called`);
      return { passed: b < a, explanation: `${g.before!.tool}@${b} ${b < a ? "precedes" : "does NOT precede"} ${g.after!.tool}@${a}` };
    }
    case "tool_used": {
      const n = run.calls.filter((call) => matches(call, g as ToolRef)).length;
      const [min, max] = [g.min ?? 1, g.max ?? Infinity];
      return { passed: n >= min && n <= max, explanation: `${g.tool} called ${n}x (expected ${min}..${max === Infinity ? "∞" : max})` };
    }
    case "file_exists": {
      const found = run.diff.some((p) => globRe(g.path!).test(p));
      return found === g.exists
        ? { passed: true, explanation: `${g.path} ${g.exists ? "exists" : "absent"} as expected` }
        : fail(`${g.path} ${found ? "exists" : "missing"} (expected ${g.exists ? "present" : "absent"})`);
    }
    case "llm": {
      const text = g.focus === "trace" ? elide(run.trace) : clip(await source(g.focus!, run));
      const shown = !text && g.focus === "files" ? "(no file changes)" : text;
      return judge(`You are grading the output of a coding agent against a criterion.\n\nCriterion:\n${g.criteria}\n\n\nAgent output (${label(g.focus!)}):\n${shown}\n\n\n${VERDICT}`, ctx);
    }
    default: {
      const raw = await readFile(resolve(c.dir, g.baseline_file!), "utf8").catch(() => null);
      if (raw === null) return fail(`baseline file ${g.baseline_file} does not exist`);
      const base = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
      return judge([
        "You are comparing a NEW coding-agent trajectory against a BASELINE.", `Criterion:\n${g.criteria}`,
        `\nBASELINE trajectory:\n${elide(base)}`, `\nNEW trajectory:\n${elide(run.trace)}`,
        "\nDoes the NEW trajectory satisfy the criterion at least as well as the BASELINE?", VERDICT,
      ].join("\n\n"), ctx);
    }
  }
}

const withOnly = (g: Grader) => g.arm === "with-only" || (g.arm === undefined && g.type === "tool_used" && g.tool === "Skill");
const assertion = (g: Grader) => g.criteria ?? g.name;

async function gradeRun(c: Case, arm: Arm, run: Run, ctx: Ctx): Promise<Verdict[]> {
  const all = c.graders.every(withOnly);
  const out: Verdict[] = [];
  for (const g of arm === "without_skill" && !all ? c.graders.filter((g) => !withOnly(g)) : c.graders) {
    const v = await grade(g, run, c, ctx).catch((e) => ({ passed: false, explanation: `grader threw: ${e.message}` }));
    out.push({ name: g.name, text: assertion(g), weight: g.weight, scored: all || !withOnly(g), ...v });
  }
  return out;
}

const score = (vs: Verdict[]) => {
  const s = vs.filter((v) => v.scored);
  return sum(s.filter((v) => v.passed).map((v) => v.weight)) / (sum(s.map((v) => v.weight)) || 1);
};

/** Run, grade and record one (case, arm, run) in the workspace layout. */
async function runOne(c: Case, arm: Arm, i: number, ctx: Ctx): Promise<Json> {
  const dir = join(ctx.out, c.name, arm, `run-${i}`);
  const outputs = join(dir, "outputs");
  await mkdir(outputs, { recursive: true });
  const events: Json[] = [];
  const run = await execute(c, arm, ctx, events);
  const verdicts = run.ungraded ? [] : await gradeRun(c, arm, run, ctx);
  for (const p of run.diff) {
    await mkdir(dirname(join(outputs, p)), { recursive: true });
    await copyFile(join(run.sandbox, p), join(outputs, p));
  }
  await rm(run.sandbox, { recursive: true, force: true });

  const s = score(verdicts);
  const scored = verdicts.filter((v) => v.scored);
  const counts: Record<string, number> = {};
  for (const call of run.calls) counts[call.name] = (counts[call.name] ?? 0) + 1;
  const secs = run.ms / 1000;
  await Promise.all([
    writeFile(join(outputs, "final_message.md"), run.last),
    writeFile(join(dir, "transcript.jsonl"), events.map(j).join("\n")),
    writeFile(join(dir, "timing.json"), j({ total_tokens: run.tokens, duration_ms: run.ms, total_duration_seconds: secs })),
    writeFile(join(dir, "grading.json"), JSON.stringify({
      expectations: verdicts.map((v) => ({ text: v.scored ? v.text : `(not scored) ${v.text}`, passed: v.passed, evidence: v.explanation })),
      summary: { passed: scored.filter((v) => v.passed).length, failed: scored.filter((v) => !v.passed).length, total: scored.length, pass_rate: s },
      execution_metrics: { tool_calls: counts, total_tool_calls: run.calls.length, errors_encountered: run.calls.filter((x) => x.isError).length },
      timing: { total_duration_seconds: secs },
    }, null, 2)),
  ]);
  ctx.io.log(`${c.name} ${arm} run-${i}: ${s.toFixed(2)} (${secs.toFixed(1)}s)${run.error ? ` — ${run.error}` : ""}`);
  return { arm, run: i, score: s, error: run.error, tokens: run.tokens, cost_usd: run.cost, seconds: secs, graders: verdicts };
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()!); }));
}

const python = (args: string[], ctx: Ctx, quiet = false) =>
  exec("python3", args, { cwd: CREATOR, env: env(ctx), signal: ctx.signal, onErr: ctx.io.log, onOut: quiet ? undefined : ctx.io.log });

/** Analyst pass: agents/analyzer.md as a pi agent; its notes go after the script's in benchmark.json. */
async function analyze(ctx: Ctx, bench: string): Promise<void> {
  const notes = join(ctx.out, "analysis-notes.json");
  const task = `Analyze the benchmark results, following "Analyzing Benchmark Results".\n- benchmark_data_path: ${bench}\n- skill_path: ${ctx.skill}\n- output_path: ${notes}`;
  const args = ["-p", "--no-session", "--no-skills", "--no-context-files", "--tools", "read,write,grep,find,ls", "--append-system-prompt", join(CREATOR, "agents/analyzer.md"), ...opt("--model", ctx.judgeModel)];
  await exec("pi", args, { cwd: ctx.out, env: env(ctx), input: task, signal: ctx.signal });
  try {
    const b = JSON.parse(await readFile(bench, "utf8"));
    b.notes = [...(b.notes ?? []), ...JSON.parse(await readFile(notes, "utf8"))];
    await writeFile(bench, JSON.stringify(b, null, 2));
  } catch (e) {
    ctx.io.log(`analyzer notes skipped: ${(e as Error).message}`);
  }
}

async function evaluate(ctx: Ctx, o: Json): Promise<number> {
  const { cases, errors } = await loadCases(ctx.skill, o.case, list(o.tag));
  for (const e of errors) ctx.io.log(`case failed to load: ${e}`);
  if (!cases.length) {
    ctx.io.out(`no cases found under ${join(ctx.skill, "evals")}`);
    return 1;
  }
  const results = new Map<Case, Json[]>(cases.map((c) => [c, []]));
  const jobs = cases.flatMap((c) => ARMS.flatMap((arm) => Array.from({ length: Number(o.runs ?? c.runs) }, (_, i) => ({ c, arm, i: i + 1 }))));
  for (const c of cases) {
    await mkdir(join(ctx.out, c.name), { recursive: true });
    await writeFile(join(ctx.out, c.name, "eval_metadata.json"), j({ eval_name: c.name, prompt: c.prompt, assertions: c.graders.map(assertion) }));
  }
  ctx.io.log(`${jobs.length} runs → ${ctx.out}`);
  await pool(jobs, Math.min(8, Math.max(1, Number(o.concurrency ?? 1))), async ({ c, arm, i }) => {
    results.get(c)!.push(await runOne(c, arm, i, ctx));
  });

  const threshold = Number(o.threshold ?? 1);
  const report = {
    skill: ctx.name, skill_path: ctx.skill, output_dir: ctx.out, threshold, load_errors: errors,
    cases: cases.map((c) => {
      const runs = results.get(c)!.sort((a, b) => a.arm.localeCompare(b.arm) || a.run - b.run);
      const [w, wo] = ARMS.map((arm) => mean(runs.filter((r) => r.arm === arm).map((r) => r.score)));
      return { name: c.name, with_skill: w, without_skill: wo, delta: w - wo, passed: w >= threshold, runs };
    }),
  };
  await writeFile(join(ctx.out, "aggregate-result.json"), JSON.stringify(report, null, 2));

  const bench = join(ctx.out, "benchmark.json");
  if ((await python(["-m", "scripts.aggregate_benchmark", ctx.out, "--skill-name", ctx.name, "--skill-path", ctx.skill], ctx, true)).code === 0) await analyze(ctx, bench);
  const prev = basename(ctx.out).match(/^iteration-(\d+)$/);
  const prevDir = prev && join(dirname(ctx.out), `iteration-${Number(prev[1]) - 1}`);
  const review = join(ctx.out, "review.html");
  await python([
    "eval-viewer/generate_review.py", ctx.out, "--skill-name", ctx.name, "--static", review,
    ...(existsSync(bench) ? ["--benchmark", bench] : []), ...(prevDir && existsSync(prevDir) ? ["--previous-workspace", prevDir] : []),
  ], ctx);

  const width = Math.max(4, ...cases.map((c) => c.name.length));
  const rows = report.cases.map((c) => `${c.name.padEnd(width)}  ${c.with_skill.toFixed(2)}  ${c.without_skill.toFixed(2)}     ${c.delta >= 0 ? "+" : ""}${c.delta.toFixed(2)}${c.passed ? "" : "  FAIL"}`);
  const table = [`${"case".padEnd(width)}  with  without  delta`, ...rows, "", `results: ${ctx.out}`, `review:  ${review}`].join("\n");
  if (o.json === "") ctx.io.out(JSON.stringify(report, null, 2));
  else {
    if (o.json) await writeFile(o.json, JSON.stringify(report, null, 2));
    ctx.io.out(table);
  }
  return errors.length || report.cases.some((c) => !c.passed) ? 1 : 0;
}

/** trigger/optimize: the pi-skill-creator scripts, run in the isolated profile. */
async function script(sub: string, evalSet: string | undefined, ctx: Ctx, o: Json): Promise<number> {
  if (!evalSet) {
    ctx.io.out(USAGE);
    return 1;
  }
  const args = [
    "-m", sub === "trigger" ? "scripts.run_eval" : "scripts.run_loop", "--eval-set", evalSet, "--skill-path", ctx.skill, "--verbose",
    ...opt("--runs-per-query", o.runs), ...opt("--num-workers", o.concurrency), ...opt("--model", ctx.model),
    ...(sub === "optimize" ? ["--results-dir", o["output-dir"] ? ctx.out : join(ctx.skill, "evals/results")] : []),
  ];
  const r = await python(args, ctx, true);
  if (o.json) await writeFile(o.json, r.out);
  ctx.io.out(r.out.trim());
  if (r.code !== 0 || sub === "optimize") return r.code ?? 1;
  return JSON.parse(r.out).summary.failed ? 1 : 0;
}

/** Entry point for the CLI and the /claude-plugin-eval command. Returns the exit code. */
export async function run(argv: string[], io: Io = cli, cwd = process.cwd(), signal?: AbortSignal): Promise<number> {
  // `--json` takes an optional path: without a following *.json it means stdout.
  const args = argv.flatMap((a, i) => (a === "--json" && !/\.json$/.test(argv[i + 1] ?? "") ? ["--json="] : [a]));
  const { values: o, positionals: pos } = parseArgs({
    args, allowPositionals: true,
    options: {
      case: { type: "string" }, tag: { type: "string", multiple: true }, runs: { type: "string" },
      concurrency: { type: "string", short: "j" }, model: { type: "string" }, "judge-model": { type: "string" },
      "allow-tools": { type: "string", multiple: true }, scaffold: { type: "boolean" }, threshold: { type: "string" },
      json: { type: "string" }, "output-dir": { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  const sub = ["run", "trigger", "optimize"].includes(pos[0]) ? pos.shift()! : "run";
  const set = sub === "run" ? undefined : pos.shift();
  const evalSet = set && resolve(cwd, set);
  if (o.json) o.json = resolve(cwd, o.json);
  if (o.help) {
    io.out(USAGE);
    return 0;
  }
  const skill = resolve(cwd, pos[0] ?? ".");
  const md = await readFile(join(skill, "SKILL.md"), "utf8").catch(() => null);
  if (md === null) {
    io.out(`no SKILL.md in ${skill}\n${USAGE}`);
    return 1;
  }
  const stamp = new Date().toISOString().replace(/:/g, "-").slice(0, 19);
  const ctx: Ctx = {
    skill, name: frontmatter(md).fm.name ?? basename(skill), io, signal, model: o.model, judgeModel: o["judge-model"],
    out: resolve(cwd, o["output-dir"] ?? join(skill, "evals/results", stamp)), profile: await makeProfile(),
    granted: new Set(list(o["allow-tools"]).map(toolName)), scaffold: !!o.scaffold,
  };
  try {
    return sub === "run" ? await evaluate(ctx, o) : await script(sub, evalSet, ctx, o);
  } finally {
    await rm(ctx.profile, { recursive: true, force: true });
  }
}

if (import.meta.main) run(process.argv.slice(2)).then((code) => process.exit(code));
