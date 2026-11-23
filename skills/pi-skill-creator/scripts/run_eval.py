#!/usr/bin/env python3
"""Run trigger evaluation for a skill description.

Tests whether a skill's description causes pi to trigger (read the skill)
for a set of queries. Outputs results as JSON.
"""

import argparse
import json
import os
import select
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

from scripts.utils import parse_skill_md


def run_single_query(
    query: str,
    skill_name: str,
    skill_description: str,
    timeout: int,
    model: str | None = None,
) -> bool:
    """Run a single query and return whether the skill was triggered.

    Writes a stub skill with the description under test to a temp directory,
    then runs `pi -p --mode json` there with only that skill and read-only tools. The first
    tool call decides: a read of the stub's SKILL.md means triggered, anything
    else (or no tool call before the timeout) means not. pi exiting before
    the agent ends raises. Reading the JSONL stream lets us stop
    as soon as that call starts instead of waiting for the whole run.
    """
    with tempfile.TemporaryDirectory(prefix="pi-trigger-") as tmp:
        skill_md = Path(tmp) / "skill" / skill_name / "SKILL.md"
        skill_md.parent.mkdir(parents=True)
        # Use YAML block scalar to avoid breaking on quotes in description
        indented_desc = "\n  ".join(skill_description.split("\n"))
        skill_md.write_text(
            f"---\n"
            f"name: {skill_name}\n"
            f"description: |\n"
            f"  {indented_desc}\n"
            f"---\n\n"
            f"# {skill_name}\n\n"
            f"This skill handles: {skill_description}\n"
        )
        cwd = Path(tmp) / "cwd"
        cwd.mkdir()

        # Read-only tools and no MCP: pi has no permission prompts, and a tool may already run before we kill pi
        cmd = ["pi", "-p", "--mode", "json", "--no-session", "--no-skills", "--skill", str(skill_md), "--tools", "read,grep,find,ls", "--no-mcp"]
        if model:
            cmd.extend(["--model", model])

        process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=cwd,
        )
        process.stdin.write(query.encode())
        process.stdin.close()

        start_time = time.time()
        buffer = ""
        try:
            while time.time() - start_time < timeout:
                exited = process.poll() is not None  # once exited, this pass drains and parses the rest
                if exited:
                    remaining = process.stdout.read()
                    if remaining:
                        buffer += remaining.decode("utf-8", errors="replace")
                    lines, buffer = buffer.split("\n"), ""
                else:
                    ready, _, _ = select.select([process.stdout], [], [], 1.0)
                    if not ready:
                        continue
                    chunk = os.read(process.stdout.fileno(), 8192)
                    if not chunk:
                        time.sleep(0.1)  # EOF: wait for exit (bounded by the timeout); the poll branch parses what's left
                        continue
                    buffer += chunk.decode("utf-8", errors="replace")
                    *lines, buffer = buffer.split("\n")

                for line in lines:
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if event.get("type") == "tool_execution_start":
                        path = str((event.get("args") or {}).get("path", ""))
                        return event.get("toolName") == "read" and (
                            path == str(skill_md) or path.endswith(f"{skill_name}/SKILL.md")
                        )
                    if event.get("type") == "agent_end" and not event.get("willRetry"):
                        return False

                if exited:
                    raise RuntimeError(f"pi exited {process.returncode} without finishing")
        finally:
            # Clean up process on any exit path (return, exception, timeout)
            if process.poll() is None:
                process.kill()
                process.wait()

        return False


def run_eval(
    eval_set: list[dict],
    skill_name: str,
    description: str,
    num_workers: int,
    timeout: int,
    runs_per_query: int = 1,
    trigger_threshold: float = 0.5,
    model: str | None = None,
) -> dict:
    """Run the full eval set and return results."""
    results = []

    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        future_to_info = {}
        for item in eval_set:
            for run_idx in range(runs_per_query):
                future = executor.submit(
                    run_single_query,
                    item["query"],
                    skill_name,
                    description,
                    timeout,
                    model,
                )
                future_to_info[future] = (item, run_idx)

        query_triggers: dict[str, list[bool]] = {}
        query_items: dict[str, dict] = {}
        for future in as_completed(future_to_info):
            item, _ = future_to_info[future]
            query = item["query"]
            query_items[query] = item
            if query not in query_triggers:
                query_triggers[query] = []
            try:
                query_triggers[query].append(future.result())
            except Exception as e:
                # A failed run counts against the expectation, never as a pass
                print(f"Warning: query failed: {e}", file=sys.stderr)
                query_triggers[query].append(not item["should_trigger"])

    for query, triggers in query_triggers.items():
        item = query_items[query]
        trigger_rate = sum(triggers) / len(triggers)
        should_trigger = item["should_trigger"]
        if should_trigger:
            did_pass = trigger_rate >= trigger_threshold
        else:
            did_pass = trigger_rate < trigger_threshold
        results.append({
            "query": query,
            "should_trigger": should_trigger,
            "trigger_rate": trigger_rate,
            "triggers": sum(triggers),
            "runs": len(triggers),
            "pass": did_pass,
        })

    passed = sum(1 for r in results if r["pass"])
    total = len(results)

    return {
        "skill_name": skill_name,
        "description": description,
        "results": results,
        "summary": {
            "total": total,
            "passed": passed,
            "failed": total - passed,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Run trigger evaluation for a skill description")
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON file")
    parser.add_argument("--skill-path", required=True, help="Path to skill directory")
    parser.add_argument("--description", default=None, help="Override description to test")
    parser.add_argument("--num-workers", type=int, default=10, help="Number of parallel workers")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout per query in seconds")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Number of runs per query")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger rate threshold")
    parser.add_argument("--model", default=None, help="Model for pi -p (default: pi's configured model)")
    parser.add_argument("--verbose", action="store_true", help="Print progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text())
    skill_path = Path(args.skill_path)

    if not (skill_path / "SKILL.md").exists():
        print(f"Error: No SKILL.md found at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, original_description, content = parse_skill_md(skill_path)
    description = args.description or original_description

    if args.verbose:
        print(f"Evaluating: {description}", file=sys.stderr)

    output = run_eval(
        eval_set=eval_set,
        skill_name=name,
        description=description,
        num_workers=args.num_workers,
        timeout=args.timeout,
        runs_per_query=args.runs_per_query,
        trigger_threshold=args.trigger_threshold,
        model=args.model,
    )

    if args.verbose:
        summary = output["summary"]
        print(f"Results: {summary['passed']}/{summary['total']} passed", file=sys.stderr)
        for r in output["results"]:
            status = "PASS" if r["pass"] else "FAIL"
            rate_str = f"{r['triggers']}/{r['runs']}"
            print(f"  [{status}] rate={rate_str} expected={r['should_trigger']}: {r['query'][:70]}", file=sys.stderr)

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
