import type {
  HookCallback,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { summarizeToolActivity } from 'rbclaw-runners-shared';

const TOOL_LABELS: Readonly<Record<string, string>> = {
  Bash: '명령 실행',
  Read: '파일 읽기',
  Write: '파일 작성',
  Edit: '파일 수정',
  MultiEdit: '파일 수정',
  Glob: '파일 검색',
  Grep: '내용 검색',
  WebSearch: '웹 검색',
  WebFetch: '웹 확인',
  Agent: '서브에이전트 작업',
  Task: '서브에이전트 작업',
  TodoWrite: '작업 목록',
  ToolSearch: '도구 검색',
  Skill: '스킬 확인',
  NotebookEdit: '노트북 수정',
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolLabel(name: unknown): string {
  if (typeof name !== 'string') return '도구 작업';
  return Object.hasOwn(TOOL_LABELS, name)
    ? TOOL_LABELS[name]
    : name.startsWith('mcp__')
      ? 'MCP 도구'
      : '도구 작업';
}

/** Share Codex's fail-closed formatter; never display raw inputs or outputs. */
function toolDetail(name: unknown, input: unknown): string {
  const args = record(input);
  const item =
    name === 'Write' || name === 'Edit' || name === 'MultiEdit'
      ? { type: 'fileChange', changes: [{ path: args?.file_path }] }
      : {
          type: 'dynamicToolCall',
          tool: name === 'Bash' ? 'bash' : name,
          arguments: args,
        };
  const detail = summarizeToolActivity(item);
  return detail ? ` · ${detail}` : '';
}

function responseFailed(response: unknown): boolean {
  const value = record(response);
  return !!(
    value &&
    (value.is_error === true ||
      value.isError === true ||
      value.success === false ||
      (typeof value.exitCode === 'number' && value.exitCode !== 0) ||
      (typeof value.exit_code === 'number' && value.exit_code !== 0))
  );
}

export class ClaudeToolActivity {
  private readonly started = new Map<
    string,
    { label: string; detail: string }
  >();
  private readonly finished = new Set<string>();

  constructor(private readonly emit: (text: string) => void) {}

  readonly preToolUse: HookCallback = async (input) => {
    const event = input as PreToolUseHookInput;
    const id = event.tool_use_id;
    if (!id || this.started.has(id)) return {};
    const summary = {
      label: toolLabel(event.tool_name),
      detail: toolDetail(event.tool_name, event.tool_input),
    };
    this.started.set(id, summary);
    this.emit(`🔄 ${summary.label} 시작${summary.detail}`);
    // No additionalContext, updatedInput or model-facing hook messages.
    return {};
  };

  readonly postToolUse: HookCallback = async (input) => {
    const event = input as PostToolUseHookInput;
    const response = record(event.tool_response);
    this.finish(
      event,
      response?.interrupted === true
        ? '⏹'
        : responseFailed(response)
          ? '❌'
          : '✅',
    );
    return {};
  };

  readonly postToolUseFailure: HookCallback = async (input) => {
    const event = input as PostToolUseFailureHookInput;
    this.finish(event, event.is_interrupt ? '⏹' : '❌');
    return {};
  };

  progress(message: {
    tool_use_id?: unknown;
    tool_name?: unknown;
    elapsed_time_seconds?: unknown;
  }): string | null {
    const id =
      typeof message.tool_use_id === 'string' ? message.tool_use_id : '';
    if (this.finished.has(id)) return null;
    const summary = this.started.get(id) || {
      label: toolLabel(message.tool_name),
      detail: '',
    };
    const elapsed = message.elapsed_time_seconds;
    const duration =
      typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0
        ? ` (${Math.round(elapsed)}s)`
        : '';
    return `⏳ ${summary.label}${duration}${summary.detail}`;
  }

  private finish(
    event: { tool_use_id: string; tool_name: string; tool_input: unknown },
    icon: '✅' | '❌' | '⏹',
  ): void {
    const id = event.tool_use_id;
    if (!id || this.finished.has(id)) return;
    this.finished.add(id);
    const summary = this.started.get(id) || {
      label: toolLabel(event.tool_name),
      detail: toolDetail(event.tool_name, event.tool_input),
    };
    const state = icon === '✅' ? '완료' : icon === '❌' ? '실패' : '중단됨';
    this.emit(`${icon} ${summary.label} ${state}${summary.detail}`);
  }
}
