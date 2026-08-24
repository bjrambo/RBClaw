---
name: rhymix-dev
description: Develop, review, debug, and explain Rhymix or XE code, including core request lifecycle, framework and legacy APIs, modules, addons, layouts, skins, widgets, editor components, database queries, templates, security, authentication, cache, queues, storage, CLI, testing, and deployment. Use whenever the user mentions Rhymix, 라이믹스, XE, or works in a Rhymix codebase.
---

# Rhymix Development Skill

Use this skill for both extension development and Rhymix core investigation. Ground every technical claim in the target checkout or the bundled references; never invent APIs.

## Required Workflow

1. Read the target project's `AGENTS.md`, `CLAUDE.md`, and local conventions first.
2. Inspect the actual target files before proposing or changing code.
3. Read [the bundled LLM entry guide](references/rx-docs/llms.txt), then load only the task-specific documents listed below.
4. Search the bundled corpus with `rg -n` before assuming an API, class, XML attribute, hook, or template directive exists.
5. Verify important behavior against the installed Rhymix source matching the target deployment. The source checkout wins over documentation when versions differ.
6. Run the narrowest relevant validation first, then broaden it according to risk.

Use this evidence priority:

1. Target project rules and its installed Rhymix source.
2. Current official Rhymix manual and coding standards.
3. Bundled `rx-docs` snapshot, which is source-derived but not official documentation.
4. The concise local reference files in this skill.

When reporting findings, cite concrete `file_path:line_number` locations. If the installed version is unknown, say so and avoid version-sensitive certainty.

## Reference Documents

### Full Rhymix Codebase Corpus

The complete `zodkr/rx-docs` documentation snapshot is bundled under `references/rx-docs/` at commit `98e763d782c4861c69e8c807a35031e30c46f396`.

- Start with [llms.txt](references/rx-docs/llms.txt) for architecture, conventions, and the full index.
- Use [README.md](references/rx-docs/README.md) for the human-oriented corpus map.
- Core lifecycle: `01-overview.md`, `04-bootstrap-and-request-lifecycle.md`, `05-context.md`, `06-module-handler-lifecycle.md`, `08-display-and-response.md`.
- Framework and loading: `07-router.md`, `10-framework.md`, `11-legacy-classes.md`, `12-helpers-and-globals.md`, `26-namespaces-and-autoload.md`.
- Data and security: `14-database-and-queries.md`, `15-session-and-auth.md`, `17-cache-and-queue.md`, `19-security.md`, `20-storage-and-files.md`.
- Templates and themes: `09-templates-and-skins.md`, `16-i18n-and-lang.md`, and the relevant file under `27-extension-points/`.
- Extension development: use the matching file under `27-extension-points/` for modules, addons, layouts, module skins, widgets, widgetstyles, or editor components.
- Existing core behavior: inspect `28-modules/<name>.md`, `29-addons/`, `30-widgets/`, `31-widgetstyles/`, `32-layouts/`, or `33-editor-components/`.
- Operations: `02-infrastructure.md`, `21-cli-and-scripts.md`, `22-multi-site-and-domain.md`, `24-debug-and-logging.md`, `25-config-system.md`, `35-testing-and-ci.md`.
- Integrations: `18-mail-sms-push.md`, `23-mobile-detection.md`, `34-external-libraries.md`.

Do not load the entire corpus into context. Locate terms first, for example:

```bash
rg -n "closeCursor|executeQuery" references/rx-docs
rg -n "Content Security Policy|csrf" references/rx-docs
rg -n "class=|eventHandler" references/rx-docs/27-extension-points
```

### Concise Generation References

- [Module Development](reference-module.md) — directory structure, info.xml, module.xml, class patterns, router.
- [Database](reference-database.md) — schema XML, query XML, operations, ruleset.
- [Templates](reference-template.md) — v1/v2 syntax, directives, filters, includes, resource loading.
- [Addon/Layout/Widget](reference-addon-layout-widget.md) — structure and patterns for each type.
- [API & Coding Standards](reference-api-conventions.md) — coding standards, API functions, language files.

These files are quick guides, not substitutes for source verification. For unfamiliar or version-sensitive work, consult the full corpus and target checkout.

## Critical: Modern Module Structure

ALWAYS use the modern namespace-based module structure, NOT the legacy XE-style flat file structure.

**Modern (CORRECT):**
- `conf/info.xml`, `conf/module.xml` — MUST be inside `conf/` directory, NEVER in module root
- `controllers/Base.php` (extends `\ModuleObject`), `controllers/Install.php`, `controllers/{Feature}.php`
- `models/Config.php`, `models/{Model}.php`
- `views/admin/*.blade.php`
- `composer.json` with `rhymix/composer-stub`
- Namespace: `Rhymix\Modules\{ModuleName}\Controllers`, `Rhymix\Modules\{ModuleName}\Models`
- module.xml: `class="Controllers\ClassName"` attribute

**Legacy XE-style (DO NOT generate for new modules):**
- `{name}.class.php`, `{name}.controller.php`, `{name}.view.php`, `{name}.model.php`
- module.xml: `type="view"`, `type="controller"` attributes

## Critical: Language File Format

Language files MUST use flat `$lang->key = 'value'` assignments. NEVER use arrays.

**CORRECT:**
```php
<?php
$lang->cmd_mymodule = 'My Module';
$lang->cmd_mymodule_config = 'Settings';
$lang->msg_success = 'Success';
```

**WRONG (will NOT work):**
```php
<?php
$lang->mymodule = [
    'title' => 'My Module',
    'config' => 'Settings',
];
```

## Critical: Only Use Verified APIs

NEVER guess or invent method names. Only use API methods listed in the reference documents. Common mistakes to avoid:
- `ModuleHandler::getSkins()` — DOES NOT EXIST. Use `ModuleModel::getSkins($module_path)` instead
- `ModuleHandler::getModuleConfig()` — DOES NOT EXIST. Use `ModuleModel::getModuleConfig($module_name)`
- Do NOT call static methods on classes that only support `getInstance()` pattern, and vice versa

If unsure whether a method exists, do NOT use it. Stick to the documented APIs in the reference.

## Critical: PHP Control Structure Style

NEVER use same-line opening braces for control structures. NEVER write single-line control statements.

This applies to `if`, `else`, `elseif`, `foreach`, `for`, `while`, `switch`, `try`, and `catch`.

**WRONG:**
```php
if ($cond) {
	$message = 'test';
}
```

**WRONG:**
```php
if ($cond) $message = 'test';
```

**RIGHT:**
```php
if ($cond)
{
	$message = 'test';
}
```

## Critical: Template v2 for New Code

When generating NEW templates, ALWAYS use Template v2 syntax:
- Admin views: `.blade.php` extension (mandatory)
- Skins/layouts: `.blade.php` preferred, `.html` with `@version(2)` also acceptable
- Use `{{ $var }}` (auto-escaped), `{!! $var !!}` (unescaped), `@if`, `@foreach`, `@load`, `@include`, etc.
- Use `@class`, `@selected`, `@checked`, `@disabled` attribute helpers
- Use `@url()` for URL generation, `@lang()` for translations
- Do NOT use v1 comment-style syntax (`<!--@if-->`) in new code

When REVIEWING or MODIFYING existing v1 templates (.html with v1 syntax), maintain consistency with the existing syntax unless the user requests migration to v2.

## Core Rules

### Code Generation

1. **Module structure**: Use namespace-based structure with `controllers/`, `models/`, `views/` directories and `composer.json`.
2. **Naming conventions**:
   - View actions: `disp{ModuleName}{Action}`
   - Controller actions: `proc{ModuleName}{Action}`
   - Module names: lowercase snake_case
   - Class names: PascalCase
   - Related disp/proc actions can be grouped in the same controller class file
3. **Coding style**:
   - Indentation: tabs (not spaces)
   - Braces: opening brace on the next line (classes, functions, control structures)
   - No PHP closing tag `?>`
   - Prefer `===` over `==`
   - Global constants with leading backslash: `\RX_BASEDIR`
   - New methods: visibility and type declarations required
   - Private/protected members: underscore prefix
   - PHPDoc `/** */` on all classes and functions
4. **XML config files**: info.xml, module.xml, schema, and query files must follow the exact format in references.
5. **module.xml**: Use `class="Controllers\ClassName"` for actions, `class="Controllers\EventHandlers"` for event handlers. Use `menu-name` and `admin-index` (hyphenated), not `menu_name` and `admin_index`.

### Code Validation

1. **Structure**: Verify namespace-based directory structure, `composer.json` present, required files exist.
2. **module.xml**:
   - Actions use `class` attribute pointing to correct controller class
   - Action names match actual PHP method names in the referenced class
   - Method prefix matches action type (disp for views, proc for controllers)
   - Permissions reference valid grant names or defaults (guest/member/manager/root)
   - eventHandler class/method actually exist
   - Uses modern hyphenated attributes (`admin-index`, `menu-name`)
3. **Query XML**:
   - Action is valid (select/insert/update/delete)
   - Operation is valid
   - Required conditions have variables provided
   - Table names match schema definitions
4. **PHP code**:
   - Proper namespace declarations
   - Coding standards compliance
   - Correct usage of Context, executeQuery, and other APIs
   - Permission checks not missing
   - CSRF protection verified
5. **Templates**:
   - New templates use v2 syntax
   - Proper variable escaping (watch for XSS with `{!! !!}` or `|noescape`)
   - Valid include paths

### Extension Type Selection

Recommend the appropriate type based on what the user wants to build:

| Requirement | Recommended Type |
|-------------|-----------------|
| Independent URL/pages needed | **Module** |
| Hook into request lifecycle | **Addon** |
| Site-wide layout/design | **Layout** |
| Data block display within pages | **Widget** |
| Widget appearance customization | **Widgetstyle** |
| Module output design change | **Skin** |

### Response Style

- **Generation requests**: Produce complete code with all required files. Briefly explain each file's role.
- **Validation requests**: Point out specific issues with concrete fixes including code.
- **Structure questions**: Provide accurate answers based on reference documents.
- If `$ARGUMENTS` is provided, prioritize handling that content.

### Official Documentation

Latest official docs: https://rhymix.org/manual
- Plugin overview: https://rhymix.org/manual/plugin/intro
- DB query operations: https://rhymix.org/manual/plugin/dbquery/operation
- Router: https://rhymix.org/manual/plugin/router/router
- Template v2: https://rhymix.org/manual/theme/template_v2
- Coding standards: https://rhymix.org/manual/contrib/coding-standards
