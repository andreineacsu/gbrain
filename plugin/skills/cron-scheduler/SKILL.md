---
name: cron-scheduler
version: 1.0.0
description: |
  Schedule management with staggering, quiet hours, and wake-up override.
  Validates schedules, prevents collisions, and gates delivery during quiet hours.
triggers:
  - "schedule a job"
  - "cron"
  - "quiet hours"
  - "what jobs are running"
tools:
  - search
  - get_page
  - put_page
mutating: true
when_to_use: "Use when the user asks: \"schedule a job\", \"cron\", \"quiet hours\", \"what jobs are running\"."
---

# Cron Scheduler

> **Convention:** See `skills/conventions/test-before-bulk.md` — test every cron job on 3-5 items first.

## Contract

This skill guarantees:
- Schedule staggering: max 1 job per 5-minute slot, no collisions
- Quiet hours gating: timezone-aware, with user-awake override
- Thin job prompts: jobs say "Read skills/X/SKILL.md and run it" (no inline 3000-word prompts)
- Idempotency: jobs can run twice without duplicate side effects
- Results saved as reports: `reports/{job-name}/{YYYY-MM-DD-HHMM}.md`

## Phases

1. **Define job.** Name, schedule (cron expression), skill to run, timeout.
2. **Validate schedule.** Check no collision with existing jobs (5-minute offset rule).
   - Slots: :05, :10, :15, :20, :25, :30, :35, :40, :45, :50
   - If collision detected, suggest the next available slot
3. **Check quiet hours.** Default: 11 PM - 8 AM local time.
   - Override: user-awake flag (if user is active, quiet hours suspended)
   - During quiet hours: save output to held queue
   - Morning contact releases the backlog
4. **Register with host scheduler.** OpenClaw cron, Railway cron, crontab, or process manager. **Each registered entry should execute via Minions, not `agentTurn`.** See `skills/conventions/cron-via-minions.md` for the rewrite pattern (PGLite uses `--follow`, Postgres uses fire-and-forget + `--idempotency-key` on the cycle slot). GBrain's v0.11.0 migration auto-rewrites entries for built-in handlers; host-specific handlers need a code-level registration per `docs/guides/plugin-handlers.md`.
5. **Write thin prompt.** Job prompt is one line: "Read skills/{name}/SKILL.md and run it."

## Idempotency Requirement

Every cron job MUST be idempotent:
- Running the same job twice produces the same result (no duplicate pages, no duplicate timeline entries)
- Use checkpoint state files to track progress and resume interrupted runs
- Check for existing output before creating new output

## Output Format

Job configuration saved. Report: "Job '{name}' scheduled at {cron expression}. Next run: {time}."

## Multi-source brains: use `sync --all`, not per-source entries

When the brain has 2+ active sources (anything `gbrain sources list` shows
with a non-null `local_path` that isn't archived), use one consolidated
cron line instead of N per-source entries.

**Preferred (multi-source)**:

```cron
*/5 * * * * gbrain sync --all --parallel 4 --workers 4 --skip-failed
```

This replaces N per-source lines AND auto-picks-up future sources without
a crontab edit. Concurrency budget: `parallel × workers × 2 ≈ 32`
connections during the wave (each per-file worker opens its own
2-connection pool). Stay under your Postgres `max_connections` setting.

**Managed brain** (`gbrain sources writer status --json` reports
`"mode": "managed"`): managed sync refuses a Git pull and `--skip-failed`,
so the line above fails for every source with `writer_coordinator_required`.
Install this line instead, on the host that owns the sources
(`gbrain sources writer status --source <id> --json` names a source's
owner host):

```cron
*/15 * * * * gbrain sources refresh <id>; gbrain sync --all --no-pull --hard-deadline 13m
```

- `gbrain sync --all --no-pull` imports each checkout as it stands, one
  source at a time. Managed sync takes no per-source lock, so two runs at
  once would drain side by side and stall each other. The 15-minute
  interval with a 13-minute `--hard-deadline` keeps runs apart: the drain
  stops itself shortly before the deadline as `resumable`, with its cursor
  and accepted writes intact, and the next tick continues it.
- `gbrain sources refresh <id>` is how a managed checkout takes new
  upstream commits: it fast-forwards the checkout and syncs every source
  bound to it. Put one refresh per checkout that tracks a remote (any
  source id on that checkout) in front of the sync, in the same line, so
  the jobs run one after another. Leave the refresh out when no checkout
  tracks a remote, and add one when such a checkout is added.
- A source another host owns refuses with `owner_unavailable`: give it its
  own line on its owner host, with `--source <id>` in place of `--all`.
- A file that fails to import stays failed: managed sync never skips it,
  and a refresh of its checkout refuses with `sync_in_progress` until the
  file is fixed and retried with the `--retry-failed` command the failure
  prints.

On a PGLite brain while `gbrain serve` runs, sync runs inside the serve
one source at a time and refuses `--all`, in either mode. There, chain one
`gbrain sync --source <id>` per source in the line (with `--no-pull` on a
managed brain).

**Avoid (legacy)**: separate `gbrain sync --source default` and
`gbrain sync --source zion-brain` entries staggered by 5 minutes. They
require manual deconfliction every time a new source is added, and a
slow source can race a fast source on the legacy global `gbrain-sync`
lock (v0.40.3.0+ uses per-source `gbrain-sync:<sourceId>` locks but the
per-source cron pattern doesn't benefit from the parallelism that
`--all --parallel` actually delivers).

`gbrain doctor` surfaces the recommended line for the brain's mode as a
`sync_consolidation` check whenever it detects 2+ active sources.
Paste-ready from there.

## When it fails

Follow the [agent operator protocol](../../docs/protocol/AGENT_OPERATOR_v1.md) for any gbrain error `code`, exit code, `[AGENT]` block or notice block. Specific to this skill:

- A scheduled `gbrain sync` hits `sync_in_progress` / `lock_busy`: an earlier tick still runs. Widen the interval or stagger the job; never add a second overlapping schedule. On a managed brain, a scheduled `sources refresh` that refuses with `sync_in_progress` names an unfinished or failed sync of its checkout: run the command it prints, and the next tick refreshes.
- A scheduled `gbrain sync` refuses with `writer_coordinator_required` and asks for `--no-pull`, or refuses `--skip-failed`: the brain is managed. Replace the line with the managed form under "Multi-source brains".
- A managed sync stops with `worktree_refreshing` after waiting about 5 minutes: a refresh of that checkout was still running. Keep the refresh and the sync in one line so they run one after another.
- Doctor reports a stale source after the cron change: check `gbrain sources status <id>` for held items or errors before changing the schedule again.
- `checkpoint_validation_timeout` in a sync log: run the retry command the error prints; do not cancel the request.

## Anti-Patterns

- Scheduling jobs at the same minute (:00 for everything)
- Inline 3000-word prompts in cron jobs (use skill file references)
- Running cron jobs without testing on 3-5 items first
- Jobs that produce different output on re-run (not idempotent)
- Sending notifications during quiet hours (save to held queue instead)
- Separate per-source `gbrain sync --source <id>` cron entries when
  one `--all` line would replace them and auto-pick-up future sources
  (`gbrain sync --all --parallel N --workers N` on an unmanaged brain,
  `gbrain sync --all --no-pull` on a managed one).
