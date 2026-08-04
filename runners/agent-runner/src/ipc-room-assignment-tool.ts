import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

type IpcWriter = (dir: string, data: object) => string;
type AgentType = 'claude-code' | 'codex' | 'glm-code';

interface RegisterRoomAssignmentToolOptions {
  server: McpServer;
  tasksDir: string;
  isMain: boolean;
  writeIpcFile: IpcWriter;
}

interface AssignRoomToolArgs {
  jid: string;
  name: string;
  room_mode?: 'single' | 'tribunal';
  owner_agent_type?: AgentType;
  reviewer_agent_type?: AgentType;
  arbiter_agent_type?: AgentType;
  owner_model?: string;
  owner_effort?: string;
  reviewer_model?: string;
  reviewer_effort?: string;
  arbiter_model?: string;
  arbiter_effort?: string;
  folder?: string;
  trigger?: string;
  requires_trigger?: boolean;
  is_main?: boolean;
  work_dir?: string;
  review_access_profile?: string;
}

export function registerRoomAssignmentTool(
  options: RegisterRoomAssignmentToolOptions,
): void {
  options.server.tool(
    'assign_room',
    `Assign or update a room using room-level settings. Main group only.

If folder is omitted, the host generates one automatically.`,
    {
      jid: z
        .string()
        .describe(
          'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
        ),
      name: z.string().describe('Display name for the room'),
      room_mode: z
        .enum(['single', 'tribunal'])
        .default('single')
        .describe('single=owner only, tribunal=owner/reviewer roles enabled'),
      owner_agent_type: z
        .enum(['claude-code', 'codex', 'glm-code'])
        .optional()
        .describe('Preferred owner agent type for the room'),
      reviewer_agent_type: z
        .enum(['claude-code', 'codex', 'glm-code'])
        .optional()
        .describe('Optional reviewer agent type override for tribunal rooms'),
      arbiter_agent_type: z
        .enum(['claude-code', 'codex', 'glm-code'])
        .optional()
        .describe('Optional arbiter agent type override for tribunal rooms'),
      ...Object.fromEntries(
        (['owner', 'reviewer', 'arbiter'] as const).flatMap((role) => [
          [
            `${role}_model`,
            z
              .string()
              .optional()
              .describe(`Per-room model override for the ${role} role`),
          ],
          [
            `${role}_effort`,
            z
              .string()
              .optional()
              .describe(
                `Per-room reasoning effort override for the ${role} role`,
              ),
          ],
        ]),
      ),
      folder: z
        .string()
        .optional()
        .describe(
          'Optional folder override. If omitted, the host generates one automatically.',
        ),
      trigger: z
        .string()
        .optional()
        .describe('Optional canonical trigger label to store for the room'),
      requires_trigger: z
        .boolean()
        .optional()
        .describe('Whether direct trigger mention is required'),
      is_main: z
        .boolean()
        .optional()
        .describe('Whether this room is the privileged main control room'),
      work_dir: z
        .string()
        .optional()
        .describe('Optional working directory override'),
      review_access_profile: z
        .string()
        .optional()
        .describe(
          'Optional room-scoped remote diagnostics profile. Empty string clears it.',
        ),
    },
    async (args: AssignRoomToolArgs) => {
      if (!options.isMain) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Only the main group can assign rooms.',
            },
          ],
          isError: true,
        };
      }

      options.writeIpcFile(options.tasksDir, {
        type: 'assign_room',
        jid: args.jid,
        name: args.name,
        room_mode: args.room_mode || 'single',
        owner_agent_type: args.owner_agent_type,
        reviewer_agent_type: args.reviewer_agent_type,
        arbiter_agent_type: args.arbiter_agent_type,
        owner_model: args.owner_model,
        owner_effort: args.owner_effort,
        reviewer_model: args.reviewer_model,
        reviewer_effort: args.reviewer_effort,
        arbiter_model: args.arbiter_model,
        arbiter_effort: args.arbiter_effort,
        folder: args.folder,
        trigger: args.trigger,
        requiresTrigger: args.requires_trigger,
        isMain: args.is_main,
        workDir: args.work_dir,
        review_access_profile: args.review_access_profile,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Room "${args.name}" assignment requested.`,
          },
        ],
      };
    },
  );
}
