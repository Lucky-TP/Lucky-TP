# LLM token usage chart: paused

Paused on 2026-11-24.

- The `LLM Token Usage` section was removed from `README.md` in commit `31e4890`.
- The daily `launchd` job (`com.lucky-tp.llm-usage`, 19:00) was uninstalled.
- `scripts/` and `assets/llm-usage/` are kept, so the chart can be restored.

## Resume

Run from the repository root (`~/Desktop/llm-usage/github-profile`), in this order. The updater needs the `<!-- llm-usage:start -->` / `<!-- llm-usage:end -->` markers in `README.md`, so restore the section before reinstalling the job.

```sh
git pull --ff-only
git revert 31e4890        # restore the README section and markers
git push origin main
node scripts/install-llm-usage-launch-agent.mjs
node scripts/update-llm-usage.mjs --push   # optional: refresh the chart now
```

If `git revert` conflicts in `README.md`, keep the current profile content and re-add the `### LLM Token Usage` section, including both markers and the `<details>` block, from `git show 31e4890^:README.md`.

Check the job is registered: `launchctl list | grep com.lucky-tp.llm-usage`.

Delete this file after resuming.
