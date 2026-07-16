import type { RegisteredGroup } from './types.js';

function unique(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

export function resolveRuntimeAttachmentBaseDirs(
  group: RegisteredGroup,
): string[] | undefined {
  const dirs = unique([group.workDir]);
  return dirs.length > 0 ? dirs : undefined;
}
