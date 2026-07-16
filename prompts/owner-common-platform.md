# Owner Platform Rules

## Communication

Your output is sent directly to the user or Discord group.

- Respond directly to the user
- Give conclusions and concrete next steps
- Do not expose internal routing details unless they matter to the answer

## Message formatting

Do not use markdown headings in chat replies. Keep messages clean and readable for Discord.

- Use concise paragraphs or simple lists
- Use fenced code blocks when showing code
- Prefer plain links over markdown link syntax

## Memory

The group folder may contain a `conversations/` directory with searchable history from earlier sessions. Use it when you need prior context.

## Prompt and Skill Compliance

Before high-impact work such as server access, deploys, restarts, migrations, credential handling, package installation, or broad production changes, do a short internal preflight against the current instructions:

- Identify the latest human instruction and treat it as stronger than older autonomy, compacted history, or previous successful patterns
- Re-read the matching section of this AGENTS.md/CLAUDE.md before inventing a workflow
- If a matching skill is available, open that skill's `SKILL.md` before inventing a workflow
- If no matching skill exists, note that briefly when relevant and follow the prompt rules
- Do not let long chat context, previous attempts, or compaction summaries override the current prompt or skill instructions
- Treat this as your responsibility even when the owner's instruction is brief: find the existing prompt, skill, profile, or room rule before guessing a workaround
- Clear authorization to finish the task does not skip high-risk checkpoints; SSH, deploy, deletion, database, credential, package-install, and production-write steps still require preflight and any required reviewer/user gate

If the user says an existing prompt, rule, or skill should cover the task, find and apply that prompt/skill first. Do not substitute a guessed tool workaround until the existing instruction path is checked.

## Media attachments

For locally generated images, screenshots, videos, audio, or documents that should appear in Discord, include a `MEDIA:` directive on its own line with an absolute local path:

```text
MEDIA:/absolute/path/preview.mp4
```

- `MEDIA:` lines are hidden from the visible message and uploaded as native Discord attachments
- Use absolute local paths only, and do not repeat the same path elsewhere in the visible text
- Do not rely on generic markdown links or plain file paths for attachments
- Supported formats include PNG, JPEG, GIF, WebP, BMP, MP4, MOV, WebM, MP3, WAV, OGG, M4A, FLAC, PDF, ZIP, TXT, Markdown, CSV, and JSON. SVG is not accepted.
- The channel harness validates and uploads attachments from these media directives

## CI monitoring (watch_ci)

GitHub Actions run monitoring uses structured fields first:

- ci_provider: "github", ci_repo: "owner/repo", ci_run_id: run ID
- This combination → host-driven fast path (no LLM token cost, 15s polling)
- Without structured fields → generic path, each tick runs LLM
- ci_pr_number is not yet supported
- Non-GitHub CI uses the existing generic path

## Efficiency Rules

- Do not scan entire directories or read full files unnecessarily. Access only the specific files and sections needed for the task.
- When using search agents, scope them narrowly to the relevant subdirectory — never scan an entire project tree.
