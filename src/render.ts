import type { Approval } from './store.js';
import { approvalControls, approvalDetails } from './approvals.js';
import { basename } from 'node:path';
import { fileReferences } from './file-references.js';
import type { Binding, Button, Delivery, Item, Packet, TurnState } from './types.js';

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
const visibleMessage = (item: Item) => item.type === 'agentMessage' && !item.moderation?.moderated && !item.moderation?.display
  && typeof item.text === 'string' && Boolean(item.text.trim());
const inline = (value: string) => `\`${compact(value.replace(/[\r\n]+/g, ' ').replace(/`/g, 'ˋ'), 220)}\``;

function activity(item: Item | undefined, completed: boolean): string {
  if (!item) return 'Working…';
  if (item.type === 'agentMessage') return completed && visibleMessage(item) ? item.text : 'Working…';
  if (item.type === 'commandExecution') return `${completed ? (item.status === 'failed' ? 'Command failed:' : 'Finished') : 'Running'} ${inline(item.command ?? 'command')}`;
  if (item.type === 'fileChange') {
    const paths = (item.changes ?? []).slice(0, 3).map((c: any) => inline(c.path)).join(', ');
    return `${completed ? 'Finished editing' : 'Editing'} ${paths || 'files'}${item.changes?.length > 3 ? ' …' : ''}`;
  }
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    return `${completed ? 'Finished' : 'Using'} ${inline([item.server ?? item.namespace, item.tool].filter(Boolean).join('/'))}`;
  }
  if (item.type === 'webSearch') return completed ? 'Search complete' : 'Searching the web…';
  if (item.type === 'collabAgentToolCall') return 'Coordinating agents…';
  if (item.type === 'imageGeneration') return 'Generating an image…';
  return 'Working…';
}

export function turnDelivery(binding: Binding, state: TurnState, waiting = false): Delivery {
  const { turn, completedItemIds, lastItemId } = state;
  const active = turn.status === 'inProgress';
  const status = active ? (waiting ? 'Waiting for your response' : 'Working')
    : turn.status === 'completed' ? 'Complete' : turn.status === 'interrupted' ? 'Interrupted' : 'Failed';
  const tone = active ? (waiting ? 'warning' : 'info') : turn.status === 'completed' ? 'success' : turn.status === 'interrupted' ? 'warning' : 'danger';
  let content: string;
  if (active) {
    const item = turn.items?.find(i => i.id === lastItemId);
    content = waiting ? 'Waiting for your response…' : activity(item, Boolean(item && completedItemIds.includes(item.id)));
    // Progress stays short and does not repeatedly upload full attachments.
    content = compact(content, 1500);
    if ((content.match(/^```/gm)?.length ?? 0) % 2) content += '\n```';
  } else {
    content = (turn.items ?? []).filter(i => completedItemIds.includes(i.id) && visibleMessage(i) && i.phase !== 'commentary').map(i => i.text).join('\n\n');
    if (turn.error?.message) content = [content, `Turn failed: ${turn.error.message}`].filter(Boolean).join('\n\n');
    if (!content) content = turn.status === 'completed' ? 'Turn complete.' : turn.status === 'interrupted' ? 'Turn interrupted.' : 'Turn failed.';
  }
  const model = state.model;
  const modelLabel = model ? compact(model.name, 70) : undefined;
  const delivery = card(content, { title: binding.label, hideHeader: true, tone,
    footer: [binding.parentThreadId ? compact(binding.label, 40) : 'Codex', modelLabel, model?.effort, status].filter(Boolean).join(' · ') });
  if (!active) {
    const text = (turn.items ?? []).filter(i => completedItemIds.includes(i.id) && visibleMessage(i) && i.phase !== 'commentary').map(i => i.text).join('\n\n');
    const references = fileReferences(text);
    if (references.length) delivery.artifactRequest = { cwd: binding.cwd, references };
  }
  return delivery;
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
  const review = approvalDetails(packet);
  // This is a proposed delivery. The receipt separately records whether Discord received the review.
  const actions = approvalControls(approval, 'ready');
  const permissions = packet.method === 'item/permissions/requestApproval';
  const labels = { accept: permissions ? 'Allow for this turn' : 'Approve once', decline: permissions ? 'Deny' : 'Decline', cancel: 'Cancel turn', answer: 'Answer' };
  const buttons: Button[] = actions.map(action => ({ id: `dx:${approval.token}:${action}`, label: labels[action],
    style: action === 'accept' ? 'success' : action === 'cancel' ? 'secondary' : action === 'decline' ? 'danger' : 'primary' }));
  if (approval.state === 'pending' && !actions.length) {
    if (review === 'loading') {
      details.push('Waiting for the review details from Codex. Controls will appear when the details are available.');
    } else if (packet.method === 'item/tool/requestUserInput') {
      details.push('Answer this request in the local Codex client.');
    } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(packet.method!)) {
      details.push('Use the local Codex client for this approval type.');
    } else details.push('This request type requires the local Codex client.');
  } else if (approval.state !== 'pending') details.push(`**${approval.state === 'expired' ? 'Connection changed. Use a newly replayed prompt or the local client.' : approval.state === 'uncertain' ? 'Decision delivery could not be confirmed. Waiting for Codex to replay or resolve the request; the decision will not be sent again automatically.' : approval.state === 'submitted' ? 'Decision submitted; waiting for Codex.' : 'Resolved in Codex.'}**`);
  const title = approval.state === 'pending' ? (packet.method === 'item/tool/requestUserInput' ? 'Your input is needed' : 'Approval needed')
    : approval.state === 'submitted' ? 'Response submitted' : approval.state === 'uncertain' ? 'Response unconfirmed' : approval.state === 'expired' ? 'Prompt expired' : 'Prompt resolved';
  const delivery = card(details.join('\n\n'), { title, subtitle: binding?.label ?? 'Codex',
    tone: approval.state === 'pending' ? 'warning' : approval.state === 'resolved' ? 'success' : 'neutral' }, 'approval.txt', buttons);
  // Approval details must describe the exact action, including executable, cwd,
  // file targets, and network scope. Reference hiding is for ordinary output.
  delivery.preserveReferences = true;
  delivery.approvalReview = { token: approval.token, state: review === 'ready' ? 'ready' : 'unavailable' };
  if (delivery.file && buttons.length) delivery.file.requiredForActions = true;
  return delivery;
}
