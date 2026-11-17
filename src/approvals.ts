import type { Approval } from './store.js';
import type { Delivery, Item, Packet } from './types.js';

export type ApprovalAction = 'accept' | 'decline' | 'cancel' | 'answer';

export function approvalDetails(packet: Packet): 'ready' | 'loading' | 'unsupported' {
  const p = packet.params ?? {};
  switch (packet.method) {
    case 'item/commandExecution/requestApproval':
      // A terminal-input callback cannot be reviewed using its parent command.
      if (p.kind && !['command', 'humanCommand'].includes(p.kind)) return 'unsupported';
      return typeof p.command === 'string' && p.command.trim() ? 'ready' : 'loading';
    case 'item/fileChange/requestApproval': return p.discordexDiff ? 'ready' : 'loading';
    case 'item/permissions/requestApproval': return p.permissions ? 'ready' : 'loading';
    case 'item/tool/requestUserInput':
      return p.questions?.length > 0 && p.questions.length <= 5 && !p.questions.some((q: any) => q.isSecret) ? 'ready' : 'unsupported';
    default: return 'unsupported';
  }
}

/** Fill missing review details; never replace an action already shown to an approver. */
export function enrichApproval(packet: Packet, item?: Item): Packet {
  const next = structuredClone(packet);
  const p = next.params!;
  if (next.method === 'item/commandExecution/requestApproval' && item?.type === 'commandExecution'
    && (!p.kind || ['command', 'humanCommand'].includes(p.kind))) {
    p.command ??= item.command;
    p.cwd ??= item.cwd;
  }
  if (next.method === 'item/fileChange/requestApproval' && item?.type === 'fileChange' && item.changes?.length
    && item.changes.every((c: any) => typeof c.diff === 'string')) {
    p.discordexDiff ??= item.changes.map((c: any) => `${c.path}\n${c.diff}`).join('\n');
  }
  return next;
}

// The subset of daemon decisions that Discord can safely collect and submit.
export function approvalActions(packet: Packet): ApprovalAction[] {
  if (approvalDetails(packet) !== 'ready') return [];
  const p = packet.params!;
  switch (packet.method) {
    case 'item/tool/requestUserInput':
      return p.questions?.length <= 5 && !p.questions.some((q: any) => q.isSecret) ? ['answer'] : [];
    case 'item/permissions/requestApproval':
      return ['accept', 'decline'];
    case 'item/fileChange/requestApproval':
      if (!p.discordexDiff) return [];
      // File and command approvals share the same one-time decisions.
    case 'item/commandExecution/requestApproval': {
      const available = p.availableDecisions ?? ['accept', 'decline', 'cancel'];
      return (['accept', 'decline', 'cancel'] as const).filter(action => available.includes(action));
    }
    default: return [];
  }
}

/** Both rendered controls and click handling use this eligibility rule. */
export function approvalControls(approval: Approval, delivery = approval.reviewDelivery ?? 'pending'): ApprovalAction[] {
  return approval.state === 'pending' && delivery === 'ready' ? approvalActions(JSON.parse(approval.packet)) : [];
}

/** Losing a required review file is an explicit delivery outcome, not a formatting choice. */
export function unavailableReview(delivery: Delivery): Delivery {
  return { ...delivery, buttons: undefined,
    approvalReview: delivery.approvalReview && { ...delivery.approvalReview, state: 'unavailable' } };
}
