# pi-config

Personal Pi extensions.

## extensions
- `extensions/claude-plugin-eval/`: mimic Claude skill evals against pi, as `/claude-plugin-eval` or `bun extensions/claude-plugin-eval/runner.ts`
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


