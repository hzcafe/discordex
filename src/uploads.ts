import { defaultArtifacts, type ArtifactConfig } from './config.js';
import type { Delivery, UploadFile } from './types.js';
import { presentDelivery } from './references.js';
import { card } from './render.js';
import { unavailableReview } from './approvals.js';

export const localReviewNotice = 'The full approval details exceed the attachment size limit, so approval buttons are unavailable here. Open this session in Codex on the host to review and respond.';
export const rejectedReviewNotice = 'Discord rejected the file containing the full approval details. This request is still waiting. Open this session in Codex on the host to review and respond.';
export const retryingReviewNotice = 'The full approval details are temporarily unavailable. Discordex is retrying automatically. Approval buttons will appear when the details arrive.';

/** Remove only the notice added by our long-response renderer. */
export function withoutGeneratedFile(delivery: Delivery): Delivery {
  return { ...(delivery.file?.requiredForActions ? unavailableReview(delivery) : delivery), file: undefined, content: delivery.file
    ? delivery.content.replace(/\n\nFull text (?:attached|below)\.$/, '') : delivery.content };
}

/** Apply upload limits before committing any attachment reference replacements. */
export function prepareUploads(delivery: Delivery, artifacts: UploadFile[] = [], limits: ArtifactConfig = defaultArtifacts) {
  const notes = [...delivery.artifactNotes ?? []];
  let omitGenerated = false;
  const omit = (value: Delivery) => {
    notes.push(`${value.file!.name}: exceeds the attachment size limit. Full text is available in the local Codex session.`);
    if (value.file!.requiredForActions) notes.push(localReviewNotice);
    omitGenerated = true;
    delivery = withoutGeneratedFile(delivery);
    return withoutGeneratedFile(value);
  };
  // Do not parse an arbitrarily large generated transcript just to reject its upload.
  if (delivery.file && Buffer.byteLength(delivery.file.content) > Math.min(limits.maxFileBytes, limits.maxTotalBytes)) omit(delivery);
  let selected = artifacts;
  // Rewriting can grow the response file and its share of the upload budget.
  // Only remove candidates; repeat from the original text until every label has a file.
  for (;;) {
    let presented = presentDelivery(delivery, selected);
    if (presented.content.length > 3400) {
      let bounded = card(presented.content, presented.card ?? { title: 'Codex' });
      if (omitGenerated) bounded = withoutGeneratedFile(bounded);
      presented = { ...presented, content: bounded.content, file: presented.file ?? bounded.file };
    }
    if (presented.file && Buffer.byteLength(presented.file.content) > Math.min(limits.maxFileBytes, limits.maxTotalBytes)) presented = omit(presented);
    let remaining = limits.maxTotalBytes - (presented.file ? Buffer.byteLength(presented.file.content) : 0);
    const accepted: UploadFile[] = [];
    for (const file of selected) {
      if (accepted.length >= limits.maxFiles) { notes.push('Additional files omitted: attachment count limit.'); break; }
      // Retained Discord attachments have empty buffers, but still count toward the budget.
      const size = Math.max(file.size, file.data.length);
      if (size > limits.maxFileBytes || size > remaining) {
        notes.push(`${file.name}: exceeds the attachment size limit.`); continue;
      }
      accepted.push(file); remaining -= size;
    }
    if (accepted.length !== selected.length) { selected = accepted; continue; }
    const files = [...selected];
    if (presented.file) {
      const data = Buffer.from(presented.file.content);
      files.unshift({ name: presented.file.name, data, size: data.length, kind: 'file',
        hash: new Bun.CryptoHasher('sha256').update(data).digest('hex') });
    }
    return { delivery: { ...presented, artifactNotes: [...new Set(notes)] }, files };
  }
}
