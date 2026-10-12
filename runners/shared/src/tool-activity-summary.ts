const MAX_INPUT = 16_384;
const MAX_SUMMARIES = 3;
const PROGRAMS = new Set([
  'bun',
  'npm',
  'pnpm',
  'yarn',
  'git',
  'node',
  'python',
  'python3',
  'bash',
  'sh',
  'pwsh',
  'powershell',
  'powershell.exe',
  'cmd.exe',
  'winget',
  'winget.exe',
  'systemctl',
  'rg',
  'grep',
  'sed',
  'cat',
  'head',
  'tail',
  'ls',
  'pwd',
  'find',
  'findmnt',
  'mount',
  'mountpoint',
  'df',
  'du',
  'curl',
  'wget',
  'dotnet',
  'cargo',
  'go',
  'pytest',
]);
const SCRIPTS = new Set([
  'test',
  'typecheck',
  'typecheck:all',
  'build',
  'build:all',
  'build:runners',
  'verify:dist',
  'lint',
  'check',
  'format:check',
  'dashboard:build',
  'setup',
  'start',
  'dev',
  'deploy',
]);
const VERBS = new Set([
  'status',
  'diff',
  'show',
  'log',
  'add',
  'commit',
  'push',
  'fetch',
  'pull',
  'restore',
  'reset',
  'checkout',
  'revert',
  'merge',
  'rebase',
  'branch',
  'rev-parse',
  'ls-remote',
  'install',
  'uninstall',
  'update',
  'upgrade',
  'list',
  'run',
  'build',
  'test',
  'check',
  'start',
  'stop',
  'restart',
  'reload',
  'is-active',
  'reset-failed',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Only a conservative basename, never a full path or a free-form value. */
function fileName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_INPUT) return null;
  if (/[\u0000-\u001f\u007f-\u009f`@]/u.test(value)) return null;
  const name = value.replaceAll('\\', '/').split('/').pop() || '';
  if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(name)) return null;
  if (
    /token|secret|password|credential|private.?key|bearer|sk-|gh[pousr]_|eyJ/iu.test(
      name,
    )
  )
    return null;
  return /\.(?:[cm]?[jt]sx?|json|md|ya?ml|toml|ini|cfg|cs|csproj|py|sh|ps1|ahk|html|css)$/iu.test(
    name,
  ) || ['.env', '.gitignore', 'bun.lock', 'Cargo.lock', 'go.mod'].includes(name)
    ? name
    : null;
}

function joinSummaries(values: string[], incomplete = false): string | null {
  const unique = [...new Set(values)];
  if (!unique.length) return null;
  const shown: string[] = [];
  for (const value of unique) {
    if (
      shown.length >= MAX_SUMMARIES ||
      [...shown, value].join(' · ').length > 100
    )
      break;
    shown.push(value);
  }
  return (
    shown.join(' · ') + (incomplete || unique.length > shown.length ? ' …' : '')
  );
}

/** Fail closed: return fixed vocabulary, not redacted slices of raw arguments. */
export function summarizeCommand(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_INPUT) return null;
  const line = value
    .split('\n')
    .find((part) => part.trim() && !/^\s*set\s+-[euo]+\s*$/u.test(part));
  if (!line) return null;
  const words = line.match(/"[^"]*"|'[^']*'|[^\s;&|]+/gu) || [];
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[0] || ''))
    words.shift();
  const rawProgram = words.shift()?.replace(/^(["'])(.*)\1$/u, '$2') || '';
  const program =
    rawProgram.replaceAll('\\', '/').split('/').pop()?.toLowerCase() || '';
  if (!PROGRAMS.has(program)) return null;
  const prefix = [program];
  if (program === 'systemctl' && words[0] === '--user')
    prefix.push(words.shift()!);
  if (['bun', 'npm', 'pnpm', 'yarn'].includes(program)) {
    if (words[0] === 'run') {
      prefix.push(words.shift()!);
      if (SCRIPTS.has(words[0] || '')) prefix.push(words.shift()!);
    } else if (SCRIPTS.has(words[0] || '') || words[0] === 'install') {
      prefix.push(words.shift()!);
    }
  } else if (
    [
      'git',
      'systemctl',
      'winget',
      'winget.exe',
      'dotnet',
      'cargo',
      'go',
    ].includes(program)
  ) {
    if (VERBS.has(words[0] || '')) prefix.push(words.shift()!);
  } else if (program === 'rg' && words[0] === '--files') {
    prefix.push(words.shift()!);
  }
  return (
    prefix.join(' ') +
    (words.length || value.trim() !== line.trim() ? ' …' : '')
  );
}

interface Token {
  value: string | null;
  literal?: boolean;
}

/** A deliberately limited lexer: never evaluates JS, substitutions or variables. */
function staticTokens(code: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < code.length; ) {
    if (/\s/u.test(code[i])) {
      i++;
      continue;
    }
    if (code.startsWith('//', i)) {
      const end = code.indexOf('\n', i + 2);
      i = end < 0 ? code.length : end + 1;
      continue;
    }
    if (code.startsWith('/*', i)) {
      const end = code.indexOf('*/', i + 2);
      if (end < 0) return [];
      i = end + 2;
      continue;
    }
    const quote = code[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      let value = '';
      let valid = true;
      let closed = false;
      i++;
      for (; i < code.length; i++) {
        if (quote === '`' && code.startsWith('${', i)) return [];
        if (code[i] === quote) {
          i++;
          closed = true;
          break;
        }
        if (code[i] === '\\') {
          const escaped = code[++i];
          const escapes: Record<string, string> = {
            n: '\n',
            r: '\r',
            t: '\t',
            '\\': '\\',
            "'": "'",
            '"': '"',
            '`': '`',
          };
          if (escaped && Object.hasOwn(escapes, escaped))
            value += escapes[escaped];
          else valid = false;
        } else value += code[i];
      }
      if (!closed) return [];
      tokens.push({ value: valid ? value : null, literal: true });
    } else {
      // Regex literals and ambiguous division are outside this safe subset.
      if (quote === '/') return [];
      const word = code.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$]*/u)?.[0];
      tokens.push({ value: word || quote });
      i += word?.length || 1;
    }
  }
  return tokens;
}

function staticCommandArgument(
  tokens: Token[],
  keyIndex: number,
): string | null {
  const argument = tokens[keyIndex + 2];
  const next = tokens[keyIndex + 3]?.value;
  return argument?.literal &&
    argument.value !== null &&
    [',', '}'].includes(next || '')
    ? argument.value
    : null;
}

function literalCommands(code: string): string[] {
  const tokens = staticTokens(code);
  const commands: string[] = [];
  for (let i = 0; i < tokens.length - 5; i++) {
    if (
      tokens[i].literal ||
      tokens[i].value !== 'tools' ||
      tokens[i + 1].value !== '.' ||
      tokens[i + 2].value !== 'exec_command' ||
      tokens[i + 3].value !== '(' ||
      tokens[i + 4].value !== '{'
    )
      continue;
    let depth = 1;
    let command: string | null = null;
    let valid = true;
    let seen = false;
    let expectKey = true;
    let j = i + 5;
    for (; j < tokens.length && depth > 0; j++) {
      const token = tokens[j];
      if (depth === 1 && expectKey && token.value !== '}') {
        // Computed keys, shorthand, getters and spreads can replace cmd.
        if (
          !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(token.value || '') ||
          tokens[j + 1]?.value !== ':'
        ) {
          valid = false;
        } else if (token.value === 'cmd') {
          const argument = staticCommandArgument(tokens, j);
          if (seen || argument === null) valid = false;
          else command = argument;
          seen = true;
        }
        expectKey = false;
      }
      if (depth === 1 && token.value === ',' && !token.literal)
        expectKey = true;
      if (['{', '[', '('].includes(token.value || '') && !token.literal)
        depth++;
      if (['}', ']', ')'].includes(token.value || '') && !token.literal)
        depth--;
    }
    if (valid && depth === 0 && command !== null) commands.push(command);
  }
  return commands;
}

function toolArguments(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return record(value);
  if (value.length > MAX_INPUT) return null;
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function summarizeCommandItem(item: Record<string, unknown>): string | null {
  const actions = Array.isArray(item.commandActions)
    ? item.commandActions
        .slice(0, 32)
        .map(record)
        .map((action) => {
          if (!action) return null;
          const name = action.type === 'read' ? fileName(action.path) : null;
          if (name) return `읽기 \`${name}\``;
          // app-server provides the inner command even when command is bash -lc.
          const command = summarizeCommand(action.command);
          return command ? `\`${command}\`` : null;
        })
        .filter((summary): summary is string => summary !== null)
    : [];
  if (actions.length)
    return joinSummaries(
      actions,
      Array.isArray(item.commandActions) && item.commandActions.length > 32,
    );
  const command = summarizeCommand(item.command);
  return command ? `\`${command}\`` : null;
}

export function summarizeToolActivity(
  item: Record<string, unknown>,
): string | null {
  if (item.type === 'commandExecution') return summarizeCommandItem(item);
  if (item.type === 'fileChange') {
    const names = Array.isArray(item.changes)
      ? item.changes
          .slice(0, 32)
          .map(record)
          .map((change) => fileName(change?.path))
          .filter((name): name is string => name !== null)
      : [];
    return joinSummaries(
      names.map((name) => `\`${name}\``),
      Array.isArray(item.changes) && item.changes.length > 32,
    );
  }
  if (item.type !== 'mcpToolCall' && item.type !== 'dynamicToolCall')
    return null;
  if (typeof item.tool !== 'string' || item.tool.length > 256) return null;
  const tool = item.tool.split(/\.|__/u).pop();
  const args = toolArguments(item.arguments);
  if (tool === 'exec_command' || tool === 'terminal' || tool === 'bash') {
    const command = summarizeCommand(args?.cmd ?? args?.command);
    return command ? `\`${command}\`` : '명령 실행';
  }
  if (tool === 'exec') {
    const code =
      typeof item.arguments === 'string' && !args ? item.arguments : args?.code;
    if (typeof code !== 'string' || code.length > MAX_INPUT) return '도구 묶음';
    const summaries = literalCommands(code)
      .map(summarizeCommand)
      .filter((command): command is string => command !== null);
    return (
      joinSummaries(summaries.map((command) => `\`${command}\``)) || '도구 묶음'
    );
  }
  if (tool === 'read_file' || tool === 'Read') {
    const name = fileName(args?.file_path ?? args?.path);
    return name ? `읽기 \`${name}\`` : '파일 읽기';
  }
  if (tool === 'apply_patch') return '패치 적용';
  if (tool === 'write_stdin') return '실행 결과 확인';
  if (tool === 'view_image') return '이미지 확인';
  return null;
}
