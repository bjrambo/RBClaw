---
name: rhymix-dev
description: Develop, review, debug, and explain Rhymix or XE code using the bundled rx-docs corpus. Use whenever the user mentions Rhymix, 라이믹스, XE, or works in a Rhymix codebase.
---

# Rhymix Development

Use the bundled `rx-docs` snapshot as this skill's sole documentation corpus. Inspect the target checkout before making technical claims or changing code.

## Required Workflow

1. Read the target project's `AGENTS.md`, `CLAUDE.md`, and local conventions.
2. Inspect the installed Rhymix source and determine its version when possible.
3. Read [llms.txt](references/rx-docs/llms.txt) for the corpus index.
4. Search `references/rx-docs/` with `rg -n`, then open only the documents relevant to the task.
5. Verify version-sensitive APIs, XML attributes, hooks, and template syntax against the installed source.
6. Run the narrowest relevant validation first, then broaden it according to risk.

Use this evidence priority:

1. Target project rules and its installed Rhymix source.
2. Current official Rhymix documentation and coding standards.
3. The bundled `rx-docs` snapshot.

The bundled corpus describes both modern Rhymix and legacy XE-compatible behavior. Never mix modern and legacy structures in generated code. If the installed version or existing extension style cannot be determined, report that uncertainty and inspect the target source before choosing a structure.

## Bundled Corpus

The complete `zodkr/rx-docs` snapshot is stored under `references/rx-docs/` at commit `98e763d782c4861c69e8c807a35031e30c46f396`.

- [README.md](references/rx-docs/README.md): human-oriented overview.
- [llms.txt](references/rx-docs/llms.txt): architecture summary and full index.
- [PROMPT.md](references/rx-docs/PROMPT.md): upstream usage guidance.
- `01-overview.md` through `26-namespaces-and-autoload.md`: core architecture, lifecycle, APIs, data, security, and operations.
- `27-extension-points/`: modules, addons, layouts, skins, widgets, widgetstyles, and editor components.
- `28-modules/` through `33-editor-components/`: installed core extension catalogs.
- `34-external-libraries.md` and `35-testing-and-ci.md`: integrations and verification.

## Search Guidance

Locate facts before loading documents:

```bash
rg -n "class=|eventHandler" references/rx-docs/27-extension-points
rg -n "executeQuery|closeCursor" references/rx-docs
rg -n "csrf|Content Security Policy" references/rx-docs
```

For extension work, read the matching file under `27-extension-points/` first, then consult the relevant core module or subsystem document. For bug investigation, search the corpus for the symbol and verify the result against the target checkout.

## Output Rules

- Cite concrete target `file_path:line_number` evidence when reviewing or explaining code.
- Do not invent APIs or infer version-sensitive behavior from memory.
- Keep generated code consistent with the target project's existing architecture.
- State explicitly when the installed source differs from the bundled snapshot.
- Validate the corpus with `node scripts/validate-rx-docs.mjs` after documentation changes.
