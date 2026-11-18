---
name: pi-skill-creator
description: Create new skills, modify and improve existing skills, and measure skill performance in pi. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill's description for better triggering accuracy.
---

# Skill Creator

A skill for creating new skills and iteratively improving them. This is Claude's skill-creator with every agent run going through pi: test runs, grading, analysis and description optimization use the `claude-plugin-eval` runner, at `../../extensions/claude-plugin-eval/runner.ts` from this skill's directory (call it `<runner>` below, run with `bun <runner> ...`). The user can run the same thing as `/claude-plugin-eval ...`.

At a high level, the process of creating a skill goes like this:

- Decide what you want the skill to do and roughly how it should do it
- Write a draft of the skill
- Create a few test prompts and run pi-with-access-to-the-skill on them
- Help the user evaluate the results both qualitatively and quantitatively
  - While the runs happen in the background, draft some quantitative evals if there aren't any (if there are some, you can either use as is or modify if you feel something needs to change about them). Then explain them to the user (or if they already existed, explain the ones that already exist)
  - Use the `eval-viewer/generate_review.py` script to show the user the results for them to look at, and also let them look at the quantitative metrics
- Rewrite the skill based on feedback from the user's evaluation of the results (and also if there are any glaring flaws that become apparent from the quantitative benchmarks)
- Repeat until you're satisfied
- Expand the test set and try again at larger scale

Your job when using this skill is to figure out where the user is in this process and then jump in and help them progress through these stages. So for instance, maybe they're like "I want to make a skill for X". You can help narrow down what they mean, write a draft, write the test cases, figure out how they want to evaluate, run all the prompts, and repeat.

On the other hand, maybe they already have a draft of the skill. In this case you can go straight to the eval/iterate part of the loop.

Of course, you should always be flexible and if the user is like "I don't need to run a bunch of evaluations, just vibe with me", you can do that instead.

Then after the skill is done (but again, the order is flexible), you can also run the skill description improver, which we have a whole separate script for, to optimize the triggering of the skill.

Cool? Cool.

## Communicating with the user

The skill creator is liable to be used by people across a wide range of familiarity with coding jargon. If you haven't heard (and how could you, it's only very recently that it started), there's a trend now where the power of AI agents is inspiring plumbers to open up their terminals, parents and grandparents to google "how to install npm". On the other hand, the bulk of users are probably fairly computer-literate.

So please pay attention to context cues to understand how to phrase your communication! In the default case, just to give you some idea:

- "evaluation" and "benchmark" are borderline, but OK
- for "JSON" and "assertion" you want to see serious cues from the user that they know what those things are before using them without explaining them

It's OK to briefly explain terms if you're in doubt, and feel free to clarify terms with a short definition if you're unsure if the user will get it.

---

## Creating a skill

### Capture Intent

Start by understanding the user's intent. The current conversation might already contain a workflow the user wants to capture (e.g., they say "turn this into a skill"). If so, extract answers from the conversation history first — the tools used, the sequence of steps, corrections the user made, input/output formats observed. The user may need to fill the gaps, and should confirm before proceeding to the next step.

1. What should this skill enable the agent to do?
2. When should this skill trigger? (what user phrases/contexts)
3. What's the expected output format?
4. Should we set up test cases to verify the skill works? Skills with objectively verifiable outputs (file transforms, data extraction, code generation, fixed workflow steps) benefit from test cases. Skills with subjective outputs (writing style, art) often don't need them. Suggest the appropriate default based on the skill type, but let the user decide.

### Interview and Research

Proactively ask questions about edge cases, input/output formats, example files, success criteria, and dependencies. Wait to write test prompts until you've got this part ironed out.

Check available MCPs - if useful for research (searching docs, finding similar skills, looking up best practices), research inline. Come prepared with context to reduce burden on the user.

### Write the SKILL.md

Based on the user interview, fill in these components:

- **name**: Skill identifier
- **description**: When to trigger, what it does. This is the primary triggering mechanism - include both what the skill does AND specific contexts for when to use it. All "when to use" info goes here, not in the body. Note: currently models have a tendency to "undertrigger" skills -- to not use them when they'd be useful. To combat this, please make the skill descriptions a little bit "pushy". So for instance, instead of "How to build a simple fast dashboard to display internal Anthropic data.", you might write "How to build a simple fast dashboard to display internal Anthropic data. Make sure to use this skill whenever the user mentions dashboards, data visualization, internal metrics, or wants to display any kind of company data, even if they don't explicitly ask for a 'dashboard.'"
- **compatibility**: Required tools, dependencies (optional, rarely needed)
- **the rest of the skill :)**

### Skill Writing Guide

#### Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    - Executable code for deterministic/repetitive tasks
    ├── references/ - Docs loaded into context as needed
    └── assets/     - Files used in output (templates, icons, fonts)
```

#### Progressive Disclosure

Skills use a three-level loading system:
1. **Metadata** (name + description) - Always in context (~100 words)
2. **SKILL.md body** - In context whenever skill triggers (<500 lines ideal)
3. **Bundled resources** - As needed (unlimited, scripts can execute without loading)

These word counts are approximate and you can feel free to go longer if needed.

**Key patterns:**
- Keep SKILL.md under 500 lines; if you're approaching this limit, add an additional layer of hierarchy along with clear pointers about where the model using the skill should go next to follow up.
- Reference files clearly from SKILL.md with guidance on when to read them
- For large reference files (>300 lines), include a table of contents

**Domain organization**: When a skill supports multiple domains/frameworks, organize by variant:
```
cloud-deploy/
├── SKILL.md (workflow + selection)
└── references/
    ├── aws.md
    ├── gcp.md
    └── azure.md
```
The agent reads only the relevant reference file.

#### Principle of Lack of Surprise

This goes without saying, but skills must not contain malware, exploit code, or any content that could compromise system security. A skill's contents should not surprise the user in their intent if described. Don't go along with requests to create misleading skills or skills designed to facilitate unauthorized access, data exfiltration, or other malicious activities. Things like a "roleplay as an XYZ" are OK though.

#### Writing Patterns

Prefer using the imperative form in instructions.

**Defining output formats** - You can do it like this:
```markdown
## Report structure
ALWAYS use this exact template:
# [Title]
## Executive summary
## Key findings
## Recommendations
```

**Examples pattern** - It's useful to include examples. You can format them like this (but if "Input" and "Output" are in the examples you might want to deviate a little):
```markdown
## Commit message format
**Example 1:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication
```

### Writing Style

Try to explain to the model why things are important in lieu of heavy-handed musty MUSTs. Use theory of mind and try to make the skill general and not super-narrow to specific examples. Start by writing a draft and then look at it with fresh eyes and improve it.

### Test Cases

After writing the skill draft, come up with 2-3 realistic test prompts — the kind of thing a real user would actually say. Share them with the user: [you don't have to use this exact language] "Here are a few test cases I'd like to try. Do these look right, or do you want to add more?" Then run them.

Save each test case as its own folder under `evals/` in the skill directory. Don't write assertions yet — just the prompts. You'll draft assertions in the next step while the runs are in progress.

```
my-skill/
├── SKILL.md
└── evals/
    └── flags-negative-quantity/   # the case name: lowercase-with-hyphens, says what's being tested
        ├── prompt.md              # run settings, then the user's task prompt
        ├── case.yaml              # the name, and what a good result looks like
        ├── graders/               # one file per assertion; a placeholder until Step 2
        └── files/                 # input files, only if the test needs any
```

Before you write the first one, read the "Test cases" section of `references/schemas.md` and copy its templates, because the format is strict. These are plain files that you write and read yourself, so this works the same everywhere, with no extra tooling. The layout is the one `claude plugin eval` reads, and the runner reads the same, so the very same tests run against pi here and against Claude Code wherever the user has it.

**If the skill already has an `evals/evals.json`** (the older format), the runner does not read it. The file belongs to the user, so never edit, convert or delete it unless they ask; to run its tests, write each as a case folder, as the "evals.json" section of `references/schemas.md` describes.

## Running and evaluating test cases

This section is one continuous sequence — don't stop partway through. Do NOT use `/skill-test` or any other testing skill.

Put results in `<skill-name>-workspace/` as a sibling to the skill directory. Within the workspace, organize results by iteration (`iteration-1/`, `iteration-2/`, etc.). The runner writes one directory per test case inside, with the case name. Keep the same case names from one iteration to the next, because the viewer matches a run to its previous output and feedback by that path.

```
<skill-name>-workspace/
└── iteration-1/
    ├── flags-negative-quantity/  # one directory per test case
    │   ├── eval_metadata.json    # the viewer takes the prompt from here
    │   ├── with_skill/
    │   │   └── run-1/            # a run directory, one per --runs
    │   │       ├── outputs/      # the files the run produced, plus final_message.md
    │   │       ├── grading.json
    │   │       ├── timing.json
    │   │       └── transcript.jsonl
    │   └── without_skill/        # the baseline, with the same contents
    ├── handles-empty-file/
    ├── aggregate-result.json     # every score and grader verdict
    ├── benchmark.json
    ├── benchmark.md
    └── review.html
```

### Step 1: Draft assertions

The runner grades as it goes, so the assertions come before the runs. Draft quantitative assertions for each test case and explain them to the user. If a test already has assertions (files in its `graders/` folder other than the placeholder), review them and explain what they check.

Good assertions are objectively verifiable and have descriptive names — they should read clearly in the benchmark viewer so someone glancing at the results immediately understands what each one checks. Subjective skills (writing style, design quality) are better evaluated qualitatively — don't force assertions onto things that need human judgment.

Save each assertion as its own file in the case's `graders/` folder and delete the placeholder. Word each assertion about the result itself ("summary.md states a total revenue of 693.5"), not about where this workflow saves it ("…in the outputs folder"). For assertions that can be checked programmatically, use a code grader (`regex`, `file_exists`, `tool_used`, `tool_order`; see `references/schemas.md`) rather than an `llm` one — they are faster, deterministic, and free. `tool_used` with `tool: Skill` checks that the skill was read; it only counts for the with-skill runs.

For a test you're leaving to human judgment, keep the placeholder. The runner judges it like any `llm` grader, against the expected outcome.

Also explain to the user what they'll see in the viewer — both the qualitative outputs and the quantitative benchmark.

### Step 2: Run everything

One command runs every case with the skill and without it, grades each run, aggregates the benchmark, adds analyst notes, and writes the viewer:

```bash
bun <runner> run <skill-path> --output-dir <workspace>/iteration-<N> --runs 1 -j 4
```

- `--allow-tools Write,Edit,Bash` if the cases may write files or run commands (the case's `allowed_tools` must list them too), and `--scaffold` if any case has input files.
- `--runs 3` (the default) when the user wants variance, `--case <glob>` or `--tag <tag>` to run a subset, `--model` to pick the model under test.
- It can take a while: run it in the background (`nohup bun <runner> run ... > <workspace>/iteration-<N>.log 2>&1 &`) and tail the log to tell the user how it's going.

What it does, in the terms of Claude's skill-creator:

1. **Runs**: each case runs as a separate `pi -p` process, in an isolated profile and an empty sandbox directory (input files are copied in by `--scaffold`). The with-skill run loads only this skill; the baseline loads no skill. `timing.json` (tokens, duration) is captured automatically.
2. **Grading**: code graders are checked against the run's trace and the files it changed; `llm` and `baseline` graders take three pi judge votes. Results go to `grading.json` with the `text`, `passed`, `evidence` fields the viewer needs.
3. **Benchmark**: `scripts/aggregate_benchmark.py` writes `benchmark.json` and `benchmark.md` (pass rate, time and tokens per configuration, mean ± stddev, and the delta).
4. **Analyst pass**: a pi agent follows `agents/analyzer.md` ("Analyzing Benchmark Results") and appends its notes to `benchmark.json` — patterns like assertions that pass regardless of the skill, high-variance cases, and time/token tradeoffs.
5. **Viewer**: `eval-viewer/generate_review.py --static` writes `review.html`, with `--previous-workspace` when `iteration-<N-1>` sits beside it.

**Improving an existing skill**: the runner's baseline is always no skill. To compare against the old version as well, snapshot the skill before editing (`cp -r <skill-path> <workspace>/skill-snapshot/`), run the runner on the snapshot into `<workspace>/iteration-<N>-old/`, and compare the two benchmarks — or use the blind comparison below.

### Step 3: Show the user

pi often runs headless, so the viewer is a static page. Tell the user something like: "The results are in `<workspace>/iteration-N/review.html`. There are two tabs — 'Outputs' lets you click through each test case and leave feedback, 'Benchmark' shows the quantitative comparison. When you're done, click 'Submit All Reviews', which downloads `feedback.json`; put it in the iteration folder and let me know."

Generate the viewer *before* evaluating outputs yourself — you want them in front of the human ASAP. Use the runner's `review.html`; there's no need to write custom HTML.

### What the user sees in the viewer

The "Outputs" tab shows one test case at a time:
- **Prompt**: the task that was given
- **Output**: the files the skill produced, rendered inline where possible
- **Previous Output** (iteration 2+): collapsed section showing last iteration's output
- **Formal Grades** (if grading was run): collapsed section showing assertion pass/fail
- **Feedback**: a textbox that auto-saves as they type
- **Previous Feedback** (iteration 2+): their comments from last time, shown below the textbox

The "Benchmark" tab shows the stats summary: pass rates, timing, and token usage for each configuration, with per-eval breakdowns and analyst observations.

Navigation is via prev/next buttons or arrow keys. When done, they click "Submit All Reviews" which saves all feedback to `feedback.json`.

### Step 4: Read the feedback

When the user tells you they're done, read `feedback.json`:

```json
{
  "reviews": [
    {"run_id": "flags-negative-quantity-with_skill-run-1", "feedback": "the chart is missing axis labels", "timestamp": "..."},
    {"run_id": "handles-empty-file-with_skill-run-1", "feedback": "", "timestamp": "..."},
    {"run_id": "csv-summary-2-with_skill-run-1", "feedback": "perfect, love this", "timestamp": "..."}
  ],
  "status": "complete"
}
```

Empty feedback means the user thought it was fine. Focus your improvements on the test cases where the user had specific complaints.

---

## Improving the skill

This is the heart of the loop. You've run the test cases, the user has reviewed the results, and now you need to make the skill better based on their feedback.

### How to think about improvements

1. **Generalize from the feedback.** The big picture thing that's happening here is that we're trying to create skills that can be used a million times (maybe literally, maybe even more who knows) across many different prompts. Here you and the user are iterating on only a few examples over and over again because it helps move faster. The user knows these examples in and out and it's quick for them to assess new outputs. But if the skill you and the user are codeveloping works only for those examples, it's useless. Rather than put in fiddly overfitty changes, or oppressively constrictive MUSTs, if there's some stubborn issue, you might try branching out and using different metaphors, or recommending different patterns of working. It's relatively cheap to try and maybe you'll land on something great.

2. **Keep the prompt lean.** Remove things that aren't pulling their weight. Make sure to read the transcripts, not just the final outputs — if it looks like the skill is making the model waste a bunch of time doing things that are unproductive, you can try getting rid of the parts of the skill that are making it do that and seeing what happens.

3. **Explain the why.** Try hard to explain the **why** behind everything you're asking the model to do. Today's LLMs are *smart*. They have good theory of mind and when given a good harness can go beyond rote instructions and really make things happen. Even if the feedback from the user is terse or frustrated, try to actually understand the task and why the user is writing what they wrote, and what they actually wrote, and then transmit this understanding into the instructions. If you find yourself writing ALWAYS or NEVER in all caps, or using super rigid structures, that's a yellow flag — if possible, reframe and explain the reasoning so that the model understands why the thing you're asking for is important. That's a more humane, powerful, and effective approach.

4. **Look for repeated work across test cases.** Read the transcripts from the test runs and notice if the runs all independently wrote similar helper scripts or took the same multi-step approach to something. If all 3 test cases resulted in the agent writing a `create_docx.py` or a `build_chart.py`, that's a strong signal the skill should bundle that script. Write it once, put it in `scripts/`, and tell the skill to use it. This saves every future invocation from reinventing the wheel.

This task is pretty important (we are trying to create billions a year in economic value here!) and your thinking time is not the blocker; take your time and really mull things over. I'd suggest writing a draft revision and then looking at it anew and making improvements. Really do your best to get into the head of the user and understand what they want and need.

### The iteration loop

After improving the skill:

1. Apply your improvements to the skill
2. Rerun all test cases with the runner into a new `iteration-<N+1>/` directory. The baseline is always `without_skill` (no skill); if you're improving an existing skill, also compare against the snapshot as described above when it helps.
3. The runner points the viewer at the previous iteration by itself
4. Wait for the user to review and tell you they're done
5. Read the new feedback, improve again, repeat

Keep going until:
- The user says they're happy
- The feedback is all empty (everything looks good)
- You're not making meaningful progress

---

## Advanced: Blind comparison

For situations where you want a more rigorous comparison between two versions of a skill (e.g., the user asks "is the new version actually better?"), there's a blind comparison system. Read `agents/comparator.md` and `agents/analyzer.md` for the details. The basic idea is: give two outputs to an independent agent without telling it which is which, and let it judge quality. Then analyze why the winner won.

Run each as a separate pi agent, with the inputs the file asks for as the prompt:

```bash
pi -p --no-session --no-skills --append-system-prompt <this-skill>/agents/comparator.md "<inputs>"
```

This is optional, and most users won't need it. The human review loop is usually sufficient.

---

## Description Optimization

The description field in SKILL.md frontmatter is the primary mechanism that determines whether the agent reads a skill. After creating or improving a skill, offer to optimize the description for better triggering accuracy.

### Step 1: Generate trigger eval queries

Create 20 eval queries — a mix of should-trigger and should-not-trigger. Save as JSON:

```json
[
  {"query": "the user prompt", "should_trigger": true},
  {"query": "another prompt", "should_trigger": false}
]
```

The queries must be realistic and something a pi user would actually type. Not abstract requests, but requests that are concrete and specific and have a good amount of detail. For instance, file paths, personal context about the user's job or situation, column names and values, company names, URLs. A little bit of backstory. Some might be in lowercase or contain abbreviations or typos or casual speech. Use a mix of different lengths, and focus on edge cases rather than making them clear-cut (the user will get a chance to sign off on them).

Bad: `"Format this data"`, `"Extract text from PDF"`, `"Create a chart"`

Good: `"ok so my boss just sent me this xlsx file (its in my downloads, called something like 'Q4 sales final FINAL v2.xlsx') and she wants me to add a column that shows the profit margin as a percentage. The revenue is in column C and costs are in column D i think"`

For the **should-trigger** queries (8-10), think about coverage. You want different phrasings of the same intent — some formal, some casual. Include cases where the user doesn't explicitly name the skill or file type but clearly needs it. Throw in some uncommon use cases and cases where this skill competes with another but should win.

For the **should-not-trigger** queries (8-10), the most valuable ones are the near-misses — queries that share keywords or concepts with the skill but actually need something different. Think adjacent domains, ambiguous phrasing where a naive keyword match would trigger but shouldn't, and cases where the query touches on something the skill does but in a context where another tool is more appropriate.

The key thing to avoid: don't make should-not-trigger queries obviously irrelevant. "Write a fibonacci function" as a negative test for a PDF skill is too easy — it doesn't test anything. The negative cases should be genuinely tricky.

### Step 2: Review with user

Present the eval set to the user for review using the HTML template:

1. Read the template from `assets/eval_review.html`
2. Replace the placeholders:
   - `__EVAL_DATA_PLACEHOLDER__` → the JSON array of eval items (no quotes around it — it's a JS variable assignment)
   - `__SKILL_NAME_PLACEHOLDER__` → the skill's name
   - `__SKILL_DESCRIPTION_PLACEHOLDER__` → the skill's current description
3. Write it to the workspace (e.g., `<workspace>/eval_review.html`) and give the user the path to open
4. The user can edit queries, toggle should-trigger, add/remove entries, then click "Export Eval Set"
5. The file downloads as `eval_set.json` on the user's machine; ask them to put it in the workspace (if several exist, the newest is the one, e.g. `eval_set (1).json`)

This step matters — bad eval queries lead to bad descriptions.

### Step 3: Run the optimization loop

Tell the user: "This will take some time — I'll run the optimization loop in the background and check on it periodically."

Save the eval set to the workspace, then run in the background:

```bash
nohup bun <runner> optimize <path-to-trigger-eval.json> <path-to-skill> \
  --model "$PI_PROVIDER/$PI_MODEL" \
  --output-dir <workspace>/description > <workspace>/optimize.log 2>&1 &
```

`$PI_PROVIDER/$PI_MODEL` is the model powering the current session, so the triggering test matches what the user actually experiences. To measure the trigger rate once without optimizing, use `bun <runner> trigger <eval-set.json> <path-to-skill>` instead.

While it runs, periodically tail the log to give the user updates on which iteration it's on and what the scores look like.

This handles the full optimization loop automatically (`scripts/run_loop.py`). It splits the eval set into 60% train and 40% held-out test, evaluates the current description (running each query 3 times to get a reliable trigger rate), then asks pi to propose improvements based on what failed. It re-evaluates each new description on both train and test, iterating up to 5 times. When it's done, it writes an HTML report (`report.html` in a timestamped folder under `--output-dir`; give the user its path) and prints JSON with `best_description` — selected by test score rather than train score to avoid overfitting.

### How skill triggering works

Understanding the triggering mechanism helps design better eval queries. Skills appear in pi's `available_skills` list with their name, description and location, and the model decides whether to read a skill's SKILL.md based on that description. A trigger eval counts a query as triggered when the run's first tool call reads that SKILL.md. The important thing to know is that the model only consults skills for tasks it can't easily handle on its own — simple, one-step queries like "read this PDF" may not trigger a skill even if the description matches perfectly, because it can handle them directly with basic tools. Complex, multi-step, or specialized queries reliably trigger skills when the description matches.

This means your eval queries should be substantive enough that the model would actually benefit from consulting a skill. Simple queries like "read file X" are poor test cases — they won't trigger skills regardless of description quality.

### Step 4: Apply the result

Take `best_description` from the JSON output and update the skill's SKILL.md frontmatter. Show the user before/after and report the scores.

---

**Updating an existing skill**: preserve the original name. Note the skill's directory name and `name` frontmatter field, and use them unchanged.

---

## Reference files

The agents/ directory contains instructions for specialized agents, which run as separate pi processes. The runner uses `analyzer.md`; read the others when you need them.

- `agents/grader.md` — How to evaluate assertions against outputs (the runner grades on its own; this is for a deeper review of a run)
- `agents/comparator.md` — How to do blind A/B comparison between two outputs
- `agents/analyzer.md` — How to analyze why one version beat another

The references/ directory has additional documentation:
- `references/schemas.md` — File formats: test case folders, the older evals.json, grading.json, etc.

---

Repeating one more time the core loop here for emphasis:

- Figure out what the skill is about
- Draft or edit the skill
- Run pi-with-access-to-the-skill on test prompts (`bun <runner> run`)
- With the user, evaluate the outputs:
  - Show them `review.html` and the benchmark
  - Run quantitative evals
- Repeat until you and the user are satisfied

Good luck!
