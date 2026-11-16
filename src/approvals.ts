import type { Packet } from './types.js';

export type ApprovalAction = 'accept' | 'decline' | 'cancel' | 'answer';

// The subset of daemon decisions that Discord can safely collect and submit.
export function approvalActions(packet: Packet): ApprovalAction[] {
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
