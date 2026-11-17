import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import { posix } from 'node:path';
import { escapeMarkdown } from 'discord.js';
import { localReference } from './file-references.js';
import type { Artifact, Delivery } from './types.js';

const location = /(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/;
const quote = (value: string) => `\`${value.replace(/`/g, 'ˋ')}\``;

/** Replace only references to attachments included in this outgoing message. */
export function displayReferences(text: string, attachments: Artifact[] = []): string {
  const names = new Map<string, string>();
  for (const file of attachments) for (const reference of file.references ?? []) names.set(posix.normalize(reference), file.name);
  if (!names.size) return text;
  const match = (value: string, url = false): string | undefined => {
    const path = localReference(value, url);
    const name = path && names.get(posix.normalize(path));
    return name ? name + (value.match(location)?.[0] ?? '') : undefined;
  };
  const root = fromMarkdown(text);
  const visit = (node: Nodes, work: (node: Nodes) => boolean | void) => {
    const pending = [node];
    while (pending.length) {
      const current = pending.pop()!;
      if (work(current) !== false && 'children' in current) pending.push(...[...current.children].reverse());
    }
  };
  const definitions = new Map<string, Extract<Nodes, { type: 'definition' }>>();
  visit(root, node => { if (node.type === 'definition') definitions.set(node.identifier.toLowerCase(), node); });
  const usedDefinitions = new Set<string>();
  const patches: { start: number; end: number; value: string }[] = [];
  const replace = (node: Nodes, value: string) => {
    const start = node.position?.start.offset; const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined && value !== text.slice(start, end)) patches.push({ start, end, value });
  };
  visit(root, node => {
    if (node.type === 'code' || node.type === 'html' || node.type === 'definition') return false;
    if (node.type === 'inlineCode') {
      const name = match(node.value);
      if (name) replace(node, quote(name));
      return false;
    }
    const identifier = node.type === 'linkReference' || node.type === 'imageReference' ? node.identifier.toLowerCase() : undefined;
    const url = node.type === 'link' || node.type === 'image' ? node.url
      : identifier ? definitions.get(identifier)?.url : undefined;
    if (url === undefined) return;
    const name = match(url, true);
    if (!name) return false;
    let description = '';
    if ('children' in node) visit(node, child => { if (child.type === 'text' || child.type === 'inlineCode') description += child.value; });
    else if ('alt' in node) description = node.alt ?? '';
    description = description.trim();
    if (description === url || match(description, true)) description = '';
    replace(node, `${description && description !== name ? `${escapeMarkdown(description)} — ` : ''}${quote(name)}`);
    if (identifier) usedDefinitions.add(identifier);
    return false;
  });
  for (const identifier of usedDefinitions) replace(definitions.get(identifier)!, '');
  if (!patches.length) return text;
  const parts: string[] = []; let offset = 0;
  for (const patch of patches.sort((a, b) => a.start - b.start)) {
    parts.push(text.slice(offset, patch.start), patch.value); offset = patch.end;
  }
  parts.push(text.slice(offset));
  return parts.join('');
}

export function presentDelivery(delivery: Delivery, attachments: Artifact[] = []): Delivery {
  // Metadata alone does not prove a snapshot is available or included in the upload.
  // Recognize the previous flag on pending approvals already saved in the outbox.
  if (!attachments.length || delivery.preserveReferences || ('reviewRequired' in delivery && delivery.reviewRequired === true)) return delivery;
  return { ...delivery, content: displayReferences(delivery.content, attachments),
    file: delivery.file && { ...delivery.file, content: displayReferences(delivery.file.content, attachments) } };
}
