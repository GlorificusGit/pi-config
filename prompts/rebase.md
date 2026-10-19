Perform a rebase of the main branch into this feature branch.
Please do the following:
- git squash the feature branch together to 1 commit compared to local main. if local main is not strictly behind the feature branch, skip this step.
- git fetch the most up to date main branch from remote.
- git rebase that main branch into the feature branch.
- fix the conflicts if any. first look for conflicts in log.md
- git push force with lease to the remote feature branch.
- summarize the conflicts
