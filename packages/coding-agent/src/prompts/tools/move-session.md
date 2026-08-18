Rescope the session to a narrower working directory.

Use this only when the session's working directory is a broad launcher root (for example a
multi-repo workspace like `~/Projects`) and the task has clearly converged on one subdirectory
or repository: after this call, every later turn resolves relative paths, the bash default cwd,
and the workspace tree from the new directory instead of rescanning the whole root.

- `path` must be an existing directory; relative paths resolve against the current session cwd.
- Use it once the target repo is identified — not speculatively — because the session file and
  caches move with the session.
- This tool is unavailable in subagent sessions and restricted profiles; ask the top-level
  session to rescope instead.
