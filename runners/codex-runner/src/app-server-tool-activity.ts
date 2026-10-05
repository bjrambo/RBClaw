const TOOL_LABELS: Readonly<Record<string, string>> = {
  commandExecution: '명령 실행',
  fileChange: '파일 변경',
  mcpToolCall: 'MCP 도구',
  dynamicToolCall: '연결 도구',
  collabAgentToolCall: '에이전트 도구',
  subAgentActivity: '서브에이전트 작업',
  webSearch: '웹 검색',
  imageView: '이미지 확인',
  imageGeneration: '이미지 생성',
  sleep: '대기',
};

/** Display metadata only. Never copy commands, arguments, results or reasoning. */
export function formatAppServerToolActivity(
  method: string,
  item: Record<string, unknown> | null | undefined,
): string | null {
  if (method !== 'item/started' && method !== 'item/completed') return null;
  if (!item || typeof item.type !== 'string') return null;
  const label = Object.hasOwn(TOOL_LABELS, item.type)
    ? TOOL_LABELS[item.type]
    : undefined;
  if (!label) return null;

  if (method === 'item/started') return `🔄 ${label} 시작`;
  if (item.status === 'declined') return `⛔ ${label} 거부됨`;
  if (item.status === 'cancelled' || item.status === 'interrupted') {
    return `⏹ ${label} 중단됨`;
  }
  if (
    item.status === 'failed' ||
    item.success === false ||
    (typeof item.exitCode === 'number' && item.exitCode !== 0) ||
    item.error != null ||
    item.failure != null ||
    (item.result as { isError?: unknown } | null | undefined)?.isError === true
  ) {
    return `❌ ${label} 실패`;
  }
  return `✅ ${label} 완료`;
}
