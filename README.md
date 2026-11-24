# pi-config

Personal Pi extensions.

## extensions
- `extensions/claude-plugin-eval/`: mimic Claude skill evals against pi, as `/claude-plugin-eval` or `bun extensions/claude-plugin-eval/runner.ts`
- `extensions/simple-pi-tools/`: one-request HTTPS tools from its `builtin-tools.json`, plus `~/.pi/agent/tools.json` (same name overrides). Inactive until opted in via `defaultTools`, e.g. `["+deepseek_search"]`
- `extensions/tools.ts`: `/tools` lists active and inactive tools by source
- `skills/pi-skill-creator/`: Claude's skill-creator, driven through `claude-plugin-eval`

## Install

```bash
pi install git:github.com/GlorificusGit/pi-config
```

## Update

```bash
pi update --extensions
```

## Usage

skill eval
```
/claude-plugin-eval path/to/skill --model deepseek/deepseek-flash:low --judge-model deepseek/deepseek-flash:low
```

## Local testing

Creates an isolated profile at `~/.pi/test` to test local changes
```bash
bun install
./scripts/setup-test
PI_CODING_AGENT_DIR=~/.pi/test pi
```


