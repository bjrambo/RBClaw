import { describe, expect, it } from 'vitest';
import { formatAppServerToolActivity } from '../src/app-server-tool-activity.js';
import {
  summarizeCommand,
  summarizeToolActivity,
} from '../src/app-server-tool-summary.js';

describe('allowlisted command previews', () => {
  it.each([
    ['bun run test', 'bun run test'],
    ['bun run build:all --token sk-private', 'bun run build:all …'],
    ['git status --short --branch', 'git status …'],
    ['git commit -m "private commit message"', 'git commit …'],
    ['git -C /private/repo log', 'git …'],
    [
      'XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart rbclaw',
      'systemctl --user restart …',
    ],
    [
      'PASSWORD=private OPENAI_API_KEY=sk-private bun run test --password private',
      'bun run test …',
    ],
    ['bun run private-script-name', 'bun run …'],
    ['set -e\nbun run verify:dist', 'bun run verify:dist …'],
    ['rg --files /private/tree', 'rg --files …'],
    [
      'curl -H "Authorization: Bearer sk-private" https://user:private@example.com',
      'curl …',
    ],
    ['bash -lc "echo private-token"', 'bash …'],
    [
      'powershell.exe -NoProfile -Command "$Password=private"',
      'powershell.exe …',
    ],
    [
      'winget.exe uninstall --id AutoHotkey.AutoHotkey',
      'winget.exe uninstall …',
    ],
    [
      '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile',
      'powershell.exe …',
    ],
    ['/private/bin/bun run typecheck', 'bun run typecheck'],
    ['node -e "console.log(private)"', 'node …'],
    ['pwd; curl --password private', 'pwd …'],
  ])(
    'summarizes without copying arbitrary arguments: %s',
    (command, expected) => {
      expect(summarizeCommand(command)).toBe(expected);
      expect(summarizeCommand(command)).not.toMatch(
        /private|sk-|Bearer|example\.com/u,
      );
    },
  );

  it.each([
    null,
    {},
    '',
    'private-tool private',
    'TOKEN=private',
    'env TOKEN=private bun run test',
    'x'.repeat(16_385),
  ])('omits unsupported or oversized input: %j', (command) => {
    expect(summarizeCommand(command)).toBeNull();
  });
});

describe('safe tool and file previews', () => {
  it('uses structured inner commands instead of showing only the shell wrapper', () => {
    expect(
      summarizeToolActivity({
        type: 'commandExecution',
        command: '/bin/bash -lc "pwd"',
        commandActions: [{ type: 'unknown', command: 'pwd' }],
      }),
    ).toBe('`pwd`');
    expect(
      summarizeToolActivity({
        type: 'commandExecution',
        command: '/bin/bash -lc "private script"',
        commandActions: [
          { type: 'unknown', command: 'git status --short' },
          {
            type: 'read',
            path: '/private/package.json',
            command: 'cat /private/package.json',
          },
          { type: 'unknown', command: 'private-tool sk-private' },
        ],
      }),
    ).toBe('`git status …` · 읽기 `package.json`');
  });

  it('shows only basenames for structured read actions and changed files', () => {
    expect(
      summarizeToolActivity({
        type: 'commandExecution',
        command: 'cat /private/project/package.json',
        commandActions: [
          { type: 'read', path: '/private/project/package.json' },
        ],
      }),
    ).toBe('읽기 `package.json`');
    expect(
      summarizeToolActivity({
        type: 'fileChange',
        changes: [
          { path: '/private/src/app.ts', diff: 'private source' },
          { path: 'C:\\Private\\hotkeys.ahk' },
        ],
      }),
    ).toBe('`app.ts` · `hotkeys.ahk`');
  });

  it.each([
    '/private/secret.json',
    '/private/token.ts',
    '/private/credentials.json',
    '/private/@everyone.md',
    '/private/foo`bar.ts',
    '/private/foo\nbar.ts',
    '/private/sk-test.md',
    '/private/ghp_abcdef.md',
    '/private/eyJabc.json',
    '/private/unknown.bin',
  ])('omits unsafe or unrecognized file names: %s', (path) => {
    expect(
      summarizeToolActivity({ type: 'fileChange', changes: [{ path }] }),
    ).toBeNull();
  });

  it.each([
    'exec_command',
    'functions.exec_command',
    'mcp__terminal__exec_command',
  ])('recognizes known command tools: %s', (tool) => {
    expect(
      summarizeToolActivity({
        type: 'mcpToolCall',
        tool,
        arguments: {
          cmd: 'bun run test --token sk-private',
          workdir: '/private',
        },
      }),
    ).toBe('`bun run test …`');
    expect(
      summarizeToolActivity({
        type: 'dynamicToolCall',
        tool,
        arguments: JSON.stringify({ cmd: 'git status --short' }),
      }),
    ).toBe('`git status …`');
  });

  it('shows safe read targets and fixed summaries for other recognized tools', () => {
    expect(
      summarizeToolActivity({
        type: 'dynamicToolCall',
        tool: 'Read',
        arguments: { file_path: '/private/AGENTS.md' },
      }),
    ).toBe('읽기 `AGENTS.md`');
    expect(
      summarizeToolActivity({
        type: 'mcpToolCall',
        tool: 'read_file',
        arguments: { path: '/private/secret.json' },
      }),
    ).toBe('파일 읽기');
    expect(
      summarizeToolActivity({
        type: 'dynamicToolCall',
        tool: 'apply_patch',
        arguments: 'private patch',
      }),
    ).toBe('패치 적용');
    expect(
      summarizeToolActivity({
        type: 'mcpToolCall',
        tool: 'write_stdin',
        arguments: { chars: 'private' },
      }),
    ).toBe('실행 결과 확인');
    expect(
      summarizeToolActivity({
        type: 'dynamicToolCall',
        tool: 'view_image',
        arguments: { path: '/private/picture.png' },
      }),
    ).toBe('이미지 확인');
    expect(
      summarizeToolActivity({
        type: 'mcpToolCall',
        tool: 'private-tool-name',
        arguments: 'private',
      }),
    ).toBeNull();
  });

  it('bounds repeated and long summaries without breaking inline code', () => {
    const names = [
      'a'.repeat(50) + '.ts',
      'b'.repeat(50) + '.ts',
      'c'.repeat(50) + '.ts',
    ];
    const summary = summarizeToolActivity({
      type: 'fileChange',
      changes: names.map((path) => ({ path })),
    })!;
    expect(summary.length).toBeLessThanOrEqual(102);
    expect(summary.endsWith(' …')).toBe(true);
    expect(summary.match(/`/gu)).toHaveLength(2);
    expect(
      summarizeToolActivity({
        type: 'fileChange',
        changes: [{ path: 'app.ts' }, { path: 'app.ts' }],
      }),
    ).toBe('`app.ts`');
  });

  it('attaches the same safe command preview to lifecycle states without outputs', () => {
    const item = {
      type: 'commandExecution',
      command: 'bun run test --password private',
      aggregatedOutput: 'private stdout',
      error: 'private error',
    };
    expect(formatAppServerToolActivity('item/started', item)).toBe(
      '🔄 명령 실행 시작 · `bun run test …`',
    );
    expect(formatAppServerToolActivity('item/completed', item)).toBe(
      '❌ 명령 실행 실패 · `bun run test …`',
    );
    expect(
      formatAppServerToolActivity('item/completed', { ...item, error: null }),
    ).toBe('✅ 명령 실행 완료 · `bun run test …`');
    expect(
      formatAppServerToolActivity('item/completed', {
        ...item,
        status: 'declined',
      }),
    ).toBe('⛔ 명령 실행 거부됨 · `bun run test …`');
  });
});

describe('literal commands inside functions.exec without evaluating code', () => {
  const preview = (code: string) =>
    summarizeToolActivity({
      type: 'dynamicToolCall',
      tool: 'exec',
      arguments: { code },
    });

  it('summarizes actual literal tool calls, not comments or strings', () => {
    const code = `// tools.exec_command({cmd: "git reset private"})
      const fake = "tools.exec_command({cmd: 'git push private'})";
      text(await tools.exec_command({cmd: 'bun run test --token private', workdir: '/private'}));
      /* tools.exec_command({cmd: 'git log private'}) */
      text(await tools.exec_command({workdir: '/private', cmd: "git status --short"}));`;
    expect(preview(code)).toBe('`bun run test …` · `git status …`');
  });

  it('supports escaped shell strings, static templates and JSON argument envelopes', () => {
    const code =
      'text(await tools.exec_command({cmd: "set -e\\nbun run test --password \\"private\\""}));';
    expect(preview(code)).toBe('`bun run test …`');
    expect(
      preview('await tools.exec_command({cmd: `git status --short`})'),
    ).toBe('`git status …`');
    expect(
      summarizeToolActivity({
        type: 'mcpToolCall',
        tool: 'functions.exec',
        arguments: code,
      }),
    ).toBe('`bun run test …`');
    expect(
      summarizeToolActivity({
        type: 'dynamicToolCall',
        tool: 'exec',
        arguments: JSON.stringify({ code }),
      }),
    ).toBe('`bun run test …`');
  });

  it.each([
    'const cmd="bun run test"; await tools.exec_command({cmd});',
    'await tools.exec_command({cmd: "git " + privateValue})',
    'await tools.exec_command({cmd: `git ${privateValue}`})',
    'await tools.exec_command({...privateOptions, cmd: "git status"})',
    'await tools.exec_command({cmd: "git status", ...privateOptions})',
    'await tools.exec_command({cmd: "git status", cmd: privateValue})',
    'await tools.exec_command({cmd: "git status", cmd: "git push"})',
    'await tools.exec_command({cmd: "git status", ["cmd"]: privateValue})',
    'await tools.exec_command({cmd: "git status", cmd})',
    'await tools.exec_command({cmd: "git status", get cmd() { return privateValue; }})',
    'await tools.exec_command({cmd: "git status", cmd() { return privateValue; }})',
    'await tools.exec_command({cmd: "git status"',
    'const r=/private/; await tools.exec_command({cmd: "git status"})',
    'await tools.exec_command({cmd: "private-tool private"})',
  ])('falls back for ambiguous, malformed or dynamic code: %s', (code) => {
    expect(preview(code)).toBe('도구 묶음');
  });

  it('never executes code while summarizing', () => {
    const code =
      'throw new Error("must not execute"); await tools.exec_command({cmd:"pwd"})';
    expect(() => preview(code)).not.toThrow();
    expect(preview(code)).toBe('`pwd`');
  });

  it('limits previews in a large batch and handles non-command tools generically', () => {
    const code = [
      'pwd',
      'git status',
      'bun run test',
      'systemctl restart rbclaw',
    ]
      .map((cmd) => `await tools.exec_command({cmd:${JSON.stringify(cmd)}});`)
      .join('\n');
    expect(preview(code)).toBe('`pwd` · `git status` · `bun run test` …');
    expect(
      preview('text(await tools.view_image({path:"/private/picture.png"}));'),
    ).toBe('도구 묶음');
    expect(preview('x'.repeat(16_385))).toBe('도구 묶음');
  });
});
