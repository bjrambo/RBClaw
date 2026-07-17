# Contributing

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, compatibility, enhancements. These should be skills.

## Skills

A skill is a Markdown instruction set that teaches an agent how to configure,
debug, or extend an RBClaw installation. Repository-provided skills are mirrored
under `.agents/skills/` and `.claude/skills/`.

A PR that contributes a skill should not modify any source files.

Your skill should contain the **instructions** an agent follows, not pre-built
feature code. See `.agents/skills/customize/SKILL.md` and
`.claude/skills/customize/SKILL.md` for the expected structure. Keep mirrored
skill copies consistent when both agent surfaces support the workflow.

### Why?

Every user should have clean and minimal code that does exactly what they need. Skills let users selectively add features to their fork without inheriting code for features they don't want.

### Testing

Test your skill on a fresh clone before submitting. Do not include local
credentials, `prompts/CUSTOM.md`, runtime data, or machine-specific paths.

For source changes, run:

```bash
bun run check
bun run verify:dist
```

For documentation-only changes, run Prettier on the touched files and
`git diff --check`.
