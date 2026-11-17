import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes } from 'mdast';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const artifactExtensions = new Set(['.md', '.markdown', '.txt', '.rst', '.pdf', '.csv', '.html', '.svg',
  '.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.mp4', '.webm', '.mov']);

export function localReference(value: string, url: boolean): string | undefined {
  let path = value.trim();
  path = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, '');
  try {
    if (path.startsWith('file:')) path = fileURLToPath(path);
    else if (path.startsWith('sandbox:/')) path = url ? decodeURIComponent(path.slice('sandbox:'.length).split('#')[0]!) : path.slice('sandbox:'.length);
    else if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//')) return;
    else if (url) path = decodeURIComponent(path.split('#')[0]!);
  } catch { return; }
  path = path.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, '');
  if (!path || /[\x00-\x1f\x7f*?<>|]/.test(path) || path.length > 4096) return;
  return path;
}

/** Parse Markdown structure so examples, HTML, and command/code blocks are never scanned. */
export function fileReferences(text: string): string[] {
  const root = fromMarkdown(text.slice(0, 256_000));
  const definitions = new Map<string, string>();
  const walk = (node: Nodes, visit: (node: Nodes) => void) => {
    visit(node);
    if ('children' in node) for (const child of node.children) walk(child, visit);
  };
  walk(root, node => { if (node.type === 'definition') definitions.set(node.identifier.toLowerCase(), node.url); });
  const references = new Set<string>();
  walk(root, node => {
    let value: string | undefined;
    if (node.type === 'link' || node.type === 'image') value = node.url;
    else if (node.type === 'inlineCode') value = node.value;
    else if (node.type === 'linkReference' || node.type === 'imageReference') value = definitions.get(node.identifier.toLowerCase());
    const path = value && localReference(value, node.type !== 'inlineCode');
    if (path && artifactExtensions.has(extname(path).toLowerCase()) && references.size < 32) references.add(path);
  });
  return [...references];
}
