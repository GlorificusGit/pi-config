---
name: tmux
description: Running long-lived dev project processes in tmux.
---

Agents should manage long running dev project processes with tmux instead of leaving untracked background processes.
Ex. running dev servers. restart them after code changes if required.

good usage:
```sh
tmux new -ds <session-name> # create session
tmux capturep -p -t <session-name> # view logs
tmux send -t <session-name> 'some command' Enter # type into it
```

remain-on-exit is set to failed