---
name: system-admin
description: Linux system administration. Use when installing packages/programs, editing system config, or making any change outside the project directory.
---
Admin tasks must be done the right way. Orderly, not hacky.

# Principles
- prefer apt over apt-get
- prefer apt for system-wide packages
- Prefer the vendor's documented install method. Don't invent a custom build or bundled binary when a packaged one exists.
- you may consider using the top level nix flake found at "$NIX_HOME/flake.nix" to install some packages. consult with the user if you find a possible nix package to use.
- Never modify system state as a side effect of an unrelated task. If the task needs a prerequisite, that prerequisite is its own step.
- No wacky workarounds: no busybox shims, no manually unpacked toolchains into `/usr/local/bin`, no editing `/etc` files to dodge a permissions error, no static binaries from random sources.
- Don't disable security controls (sudoers edits, chmod 777, SELinux/AppArmor changes) to make a command pass.

# When blocked

If a required step needs privilege or a decision you can't make, stop and ask the user:

- You need sudo/root and don't have it.
- A package is missing and installing it changes the system in a non-trivial way.
- The official method is unavailable and the alternatives are sketchy.
- Something would touch system config, services, users, or firewall.

Ask with: what failed, what you wanted to run, and what the options are. Then wait.

# Example

```
$ curl -fsSL https://bun.sh/install | bash
error: unzip is required
```

Wrong: download a static unzip into `~/.local/bin`, or extract with busybox.

Right: `sudo apt install unzip`. If you don't have sudo, tell the user unzip is required and provide the user with the exact command to run.
