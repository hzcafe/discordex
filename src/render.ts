import type { Approval } from './store.js';
import { basename } from 'node:path';
import type { Binding, Button, Delivery, Item, Packet, Turn } from './types.js';

export function deliveryNonce(key: string): string {
  return new Bun.CryptoHasher('sha256').update(key).digest('hex').slice(0, 24);
}

export function compact(text: string, max = 1800): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}
export function message(content: string, name = 'response.md', buttons?: Button[]): Delivery {
  if (content.length <= 1950) return { content, buttons };
  return { content: `${compact(content, 1750)}\n\nFull text attached.`, file: { name, content }, buttons };
}
export function card(content: string, presentation: NonNullable<Delivery['card']>, name = 'response.md', buttons?: Button[]): Delivery {
  // Leave room for the heading, footer, and attachment notice in the V2 text budget.
  if (content.length <= 3400) return { content, card: presentation, buttons };
  let preview = compact(content, 3100);
  if ((preview.match(/^```/gm)?.length ?? 0) % 2) preview += '\n```';
  return { content: `${preview}\n\nFull text below.`, card: presentation, buttons, file: { name, content } };
}
export function sessionCard(binding: Binding): Delivery {
  return card('Messages here queue work for Codex. Use `/codex steer` to guide an active turn, or `/codex stop` to interrupt it.', {
    title: binding.label, subtitle: `Connected · ${basename(binding.cwd)}${binding.parentThreadId ? ' · Subagent' : ''}`, tone: 'success',
  });
}
export function turnDelivery(binding: Binding, turn: Turn): Delivery {
  const content = turn.status === 'completed' ? 'Turn complete' : turn.status === 'interrupted' ? 'Interrupted' : 'Turn failed';
  const tone = turn.status === 'completed' ? 'success' : turn.status === 'interrupted' ? 'warning' : 'danger';
  if (turn.error) return card(turn.error.message, { title: content, subtitle: binding.label, tone });
  return card(content, { title: binding.label, tone, compact: true, hideHeader: !binding.parentThreadId });
}
export function itemDelivery(binding: Binding, item: Item): Delivery | undefined {
  if (item.type === 'agentMessage') {
    // Honor moderation and delivery suppression; never export reasoning items.
    if (item.moderation?.moderated || item.moderation?.display) return;
    if (binding.verbosity === 'quiet' && item.phase === 'commentary') return;
    if (typeof item.text === 'string' && item.text.trim()) return card(item.text, {
      title: binding.label, hideHeader: true,
      footer: `${binding.parentThreadId ? binding.label : 'Codex'} · ${item.phase === 'commentary' ? 'Progress' : 'Reply'}`,
      tone: item.phase === 'commentary' ? 'neutral' : 'info',
    });
  }
  if (binding.verbosity !== 'verbose') return;
  if (item.type === 'commandExecution') return card(`\`\`\`sh\n${item.command}\n\`\`\`\n${item.aggregatedOutput ?? ''}`, {
    title: `Command ${item.status}`, subtitle: binding.label, tone: item.status === 'failed' ? 'danger' : 'neutral',
  }, 'command.txt');
  if (item.type === 'fileChange') return card((item.changes ?? []).map((c: any) => `**${c.path}**\n\`\`\`diff\n${c.diff ?? ''}\n\`\`\``).join('\n'), {
    title: `Files ${item.status}`, subtitle: binding.label, tone: item.status === 'failed' ? 'danger' : 'neutral',
  }, 'changes.diff');
  if (item.type === 'mcpToolCall') return card(`${item.server}/${item.tool}: ${item.status}`, { title: binding.label, tone: 'neutral', compact: true });
}
export function approvalDelivery(approval: Approval, binding?: Binding): Delivery {
  const packet: Packet = JSON.parse(approval.packet);
  const p = packet.params!;
  const details = [p.reason, p.command ? `\`\`\`sh\n${p.command}\n\`\`\`` : '',
    p.cwd ? `**Working directory**\n\`${p.cwd}\`` : '',
    p.networkApprovalContext ? `**Network access**\n${JSON.stringify(p.networkApprovalContext)}` : '',
    p.additionalPermissions ? `**Additional permissions**\n${JSON.stringify(p.additionalPermissions)}` : '',
    p.permissions ? `**Requested permissions**\n${JSON.stringify(p.permissions)}` : ''].filter(Boolean);
  if (packet.method === 'item/fileChange/requestApproval') details.push(p.discordexDiff || 'The proposed diff is unavailable. Review and answer in your local Codex client.');
  if (p.questions) for (const q of p.questions) details.push(`**${q.question}**\n${(q.options ?? []).map((o: any) => `- **${o.label}** — ${o.description}`).join('\n')}`);
  let buttons: Button[] = [];
  const button = (action: string, text: string, danger = false): Button => ({ id: `dx:${approval.token}:${action}`, label: text,
    style: action === 'accept' ? 'success' : action === 'cancel' ? 'secondary' : danger ? 'danger' : 'primary' });
  if (approval.state === 'pending') {
    if (packet.method === 'item/tool/requestUserInput') {
      if (p.questions?.length <= 5 && !p.questions.some((q: any) => q.isSecret)) buttons = [button('answer', 'Answer')];
      else details.push('Answer this request in the local Codex client.');
    } else if (packet.method === 'item/permissions/requestApproval') {
      buttons = [button('accept', 'Allow for this turn'), button('decline', 'Deny', true)];
    } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(packet.method!)) {
      const available = p.availableDecisions ?? ['accept', 'decline', 'cancel'];
      buttons = [button('accept', 'Approve once'), button('decline', 'Decline', true), button('cancel', 'Cancel turn', true)]
        .filter(b => available.includes(b.id.split(':').at(-1)));
      if (packet.method === 'item/fileChange/requestApproval' && !p.discordexDiff) buttons = [];
      if (!buttons.length) details.push('Use the local Codex client for this approval type.');
    } else details.push('This request type requires the local Codex client.');
  } else details.push(`**${approval.state === 'expired' ? 'Connection changed. Use a newly replayed prompt or the local client.' : approval.state === 'submitted' ? 'Decision submitted; waiting for Codex.' : 'Resolved in Codex.'}**`);
  const title = approval.state === 'pending' ? (packet.method === 'item/tool/requestUserInput' ? 'Your input is needed' : 'Approval needed')
    : approval.state === 'submitted' ? 'Response submitted' : approval.state === 'expired' ? 'Prompt expired' : 'Prompt resolved';
  return card(details.join('\n\n'), { title, subtitle: binding?.label ?? 'Codex',
    tone: approval.state === 'pending' ? 'warning' : approval.state === 'resolved' ? 'success' : 'neutral' }, 'approval.txt', buttons);
}
