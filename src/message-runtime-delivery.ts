import {
  markWorkItemDelivered,
  markWorkItemDeliveryRetry,
  markWorkItemDeliveryUncertain,
  getPairedTaskById,
  type WorkItem,
} from './db.js';
import { logger } from './logger.js';
import { resolveActiveRole } from './message-runtime-rules.js';
import { getErrorMessage } from './utils.js';
import type { Channel, PairedTask, PairedRoomRole } from './types.js';
import { transitionPairedSupervisorState } from './paired-supervisor-state.js';

type RuntimeDeliveryLog = Pick<typeof logger, 'info' | 'warn' | 'error'>;

function buildDeliveryLogContext(
  channel: Channel,
  item: WorkItem,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    chatJid: item.chat_jid,
    channelName: channel.name,
    workItemId: item.id,
    deliveryRole: item.delivery_role ?? null,
    ...extra,
  };
}

async function removeReplacedProgressMessage(args: {
  channel: Channel;
  item: WorkItem;
  log: RuntimeDeliveryLog;
  replaceMessageId: string | null;
}): Promise<void> {
  if (!args.replaceMessageId || !args.channel.deleteMessage) return;
  try {
    await args.channel.deleteMessage(args.item.chat_jid, args.replaceMessageId);
    args.log.info(
      buildDeliveryLogContext(args.channel, args.item, {
        deliveryMode: 'send',
        replacedMessageId: args.replaceMessageId,
      }),
      'Removed tracked progress message after fallback delivery',
    );
  } catch (err) {
    args.log.warn(
      buildDeliveryLogContext(args.channel, args.item, {
        deliveryMode: 'send',
        replacedMessageId: args.replaceMessageId,
        err,
      }),
      'Failed to remove tracked progress message after fallback delivery',
    );
  }
}

export async function deliverOpenWorkItem(args: {
  channel: Channel;
  item: WorkItem;
  log: RuntimeDeliveryLog;
  attachmentBaseDirs?: string[];
  replaceMessageId?: string | null;
  isDuplicateOfLastBotFinal: (chatJid: string, text: string) => boolean;
  openContinuation: (chatJid: string) => void;
}): Promise<boolean> {
  const replaceMessageId = args.replaceMessageId ?? null;
  const attachments = args.item.attachments ?? [];
  const hasAttachments = attachments.length > 0;

  const isDuplicate = args.isDuplicateOfLastBotFinal(
    args.item.chat_jid,
    args.item.result_payload,
  );

  if (isDuplicate) {
    markWorkItemDelivered(args.item.id, null);
    args.log.info(
      buildDeliveryLogContext(args.channel, args.item, {
        preview: args.item.result_payload.slice(0, 100),
        suppressionReason: 'paired-final-duplicate',
      }),
      'Suppressed duplicate final message in paired room (marked as delivered)',
    );
    return true;
  }

  try {
    if (replaceMessageId && args.channel.editMessage && !hasAttachments) {
      args.log.info(
        buildDeliveryLogContext(args.channel, args.item, {
          deliveryAttempts: args.item.delivery_attempts + 1,
          deliveryMode: 'edit',
          replacedMessageId: replaceMessageId,
        }),
        'Attempting to deliver produced work item by replacing tracked progress message',
      );
      await args.channel.editMessage(
        args.item.chat_jid,
        replaceMessageId,
        args.item.result_payload,
      );
      markWorkItemDelivered(args.item.id, replaceMessageId);
      args.openContinuation(args.item.chat_jid);
      args.log.info(
        buildDeliveryLogContext(args.channel, args.item, {
          deliveryAttempts: args.item.delivery_attempts + 1,
          deliveryMode: 'edit',
          replacedMessageId: replaceMessageId,
        }),
        'Delivered produced work item by replacing tracked progress message',
      );
      return true;
    }
  } catch (err) {
    args.log.warn(
      buildDeliveryLogContext(args.channel, args.item, {
        deliveryAttempts: args.item.delivery_attempts + 1,
        deliveryMode: 'edit',
        replacedMessageId: replaceMessageId,
        err,
      }),
      'Failed to replace tracked progress message; falling back to a new message',
    );
  }

  try {
    args.log.info(
      buildDeliveryLogContext(args.channel, args.item, {
        attachmentCount: attachments.length,
        deliveryAttempts: args.item.delivery_attempts + 1,
        deliveryMode: 'send',
      }),
      'Attempting to deliver produced work item as a new message',
    );
    const sendResult = hasAttachments
      ? await args.channel.sendMessage(
          args.item.chat_jid,
          args.item.result_payload,
          {
            attachmentBaseDirs: args.attachmentBaseDirs,
            attachments,
            ...(args.item.delivery_key
              ? { deliveryKey: args.item.delivery_key }
              : {}),
          },
        )
      : args.item.delivery_key
        ? await args.channel.sendMessage(
            args.item.chat_jid,
            args.item.result_payload,
            { deliveryKey: args.item.delivery_key },
          )
        : await args.channel.sendMessage(
            args.item.chat_jid,
            args.item.result_payload,
          );
    await removeReplacedProgressMessage({
      channel: args.channel,
      item: args.item,
      log: args.log,
      replaceMessageId,
    });
    markWorkItemDelivered(
      args.item.id,
      sendResult
        ? {
            primaryMessageId: sendResult.primaryMessageId,
            messageIds: sendResult.messageIds,
          }
        : null,
    );
    args.openContinuation(args.item.chat_jid);
    args.log.info(
      buildDeliveryLogContext(args.channel, args.item, {
        attachmentCount: attachments.length,
        deliveryAttempts: args.item.delivery_attempts + 1,
        deliveryMode: 'send',
      }),
      'Delivered produced work item',
    );
    return true;
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    if (
      args.item.delivery_key &&
      args.channel.supportsIdempotentDelivery?.() !== true
    ) {
      markWorkItemDeliveryUncertain(args.item.id, errorMessage);
      const pairedTask = args.item.paired_task_id
        ? getPairedTaskById(args.item.paired_task_id)
        : null;
      if (
        pairedTask &&
        pairedTask.status !== 'completed' &&
        pairedTask.supervisor_state !== 'waiting_user'
      ) {
        transitionPairedSupervisorState({
          task: pairedTask,
          nextState: 'waiting_user',
          reason: 'delivery-result-uncertain',
          patch: { last_blocker_class: 'external' },
        });
      }
      args.log.error(
        buildDeliveryLogContext(args.channel, args.item, {
          deliveryMode: 'send',
          err,
        }),
        'Delivery result is uncertain on a channel without idempotent retry support',
      );
      return false;
    }
    markWorkItemDeliveryRetry(args.item.id, errorMessage);
    args.log.warn(
      buildDeliveryLogContext(args.channel, args.item, {
        attachmentCount: attachments.length,
        deliveryAttempts: args.item.delivery_attempts + 1,
        deliveryMode: 'send',
        err,
      }),
      'Failed to deliver produced work item',
    );
    return false;
  }
}

export async function processOpenWorkItemDelivery(args: {
  chatJid: string;
  runId: string;
  openWorkItem: WorkItem | null | undefined;
  pendingTask: PairedTask | null | undefined;
  channel: Channel;
  roleToChannel: Record<'owner' | 'reviewer' | 'arbiter', Channel | null>;
  log: RuntimeDeliveryLog;
  attachmentBaseDirs?: string[];
  isPairedRoom: boolean;
  getMissingRoleChannelMessage: (role: 'reviewer' | 'arbiter') => string;
  isDuplicateOfLastBotFinal: (chatJid: string, text: string) => boolean;
  openContinuation: (chatJid: string) => void;
  enqueueFollowUpAfterDeliveryRetry: (args: {
    deliveryRole: PairedRoomRole;
    pendingTask: PairedTask | null | undefined;
    workItemId: string | number;
  }) => void;
}): Promise<'not-found' | 'delivered' | 'failed'> {
  const { openWorkItem } = args;
  if (!openWorkItem) {
    return 'not-found';
  }

  if (args.isPairedRoom && openWorkItem.delivery_role == null) {
    args.log.warn(
      {
        workItemId: openWorkItem.id,
        chatJid: args.chatJid,
        pendingTaskStatus: args.pendingTask?.status ?? null,
      },
      'Paired-room delivery retry is missing a persisted delivery role; falling back to inferred routing',
    );
  }

  const deliveryRole =
    openWorkItem.delivery_role ??
    (args.pendingTask ? resolveActiveRole(args.pendingTask.status) : 'owner');
  const deliveryChannel =
    deliveryRole === 'owner' ? args.channel : args.roleToChannel[deliveryRole];
  if (!deliveryChannel) {
    const missingRole = deliveryRole === 'arbiter' ? 'arbiter' : 'reviewer';
    const errorMessage = args.getMissingRoleChannelMessage(missingRole);
    markWorkItemDeliveryRetry(openWorkItem.id, errorMessage);
    args.log.error(
      {
        workItemId: openWorkItem.id,
        role: deliveryRole,
        requiredChannel:
          missingRole === 'arbiter' ? 'discord-arbiter' : 'discord-review',
      },
      'Unable to deliver paired-room work item because the dedicated Discord role channel is not configured',
    );
    return 'failed';
  }

  const delivered = await deliverOpenWorkItem({
    channel: deliveryChannel,
    item: openWorkItem,
    log: args.log,
    attachmentBaseDirs: args.attachmentBaseDirs,
    isDuplicateOfLastBotFinal: args.isDuplicateOfLastBotFinal,
    openContinuation: args.openContinuation,
  });
  if (!delivered) {
    return 'failed';
  }

  args.enqueueFollowUpAfterDeliveryRetry({
    deliveryRole,
    pendingTask: args.pendingTask,
    workItemId: openWorkItem.id,
  });
  return 'delivered';
}
