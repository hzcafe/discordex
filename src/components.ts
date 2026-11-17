import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder,
  FileBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, TextDisplayBuilder, escapeMarkdown } from 'discord.js';
import type { Delivery, UploadedFile, UploadFile } from './types.js';
import { compact } from './render.js';
import { prepareUploads } from './uploads.js';
import type { ArtifactConfig } from './config.js';

const tones = { neutral: 0x7b8497, info: 0x7289da, success: 0x3ba55d, warning: 0xf0b232, danger: 0xed4245 };
const icons = { neutral: '•', info: '◦', success: '✓', warning: '◼', danger: '✕' };
const styles = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger };
const heading = (value: string, limit: number) => compact(escapeMarkdown(value.replace(/[\r\n]+/g, ' ')), limit);

/** Serialize both new cards and persisted legacy deliveries using Components V2. */
export function deliveryFiles(delivery: Delivery, artifacts: UploadFile[] = [], limits?: ArtifactConfig): UploadFile[] {
  return prepareUploads(delivery, artifacts, limits).files;
}

export function prepareDiscordPayload(delivery: Delivery, artifacts: UploadFile[] = [], retained: UploadedFile[] = [], limits?: ArtifactConfig) {
  const prepared = prepareUploads(delivery, artifacts, limits);
  delivery = prepared.delivery;
  const files = prepared.files;
  const meta = delivery.card;
  const tone = meta?.tone ?? 'info';
  const title = heading(meta?.title ?? 'Codex', 180);
  let components: (ContainerBuilder | TextDisplayBuilder)[];
  if (meta?.compact && !meta.footer && !files.length && !delivery.artifactNotes?.length && !delivery.buttons?.length && delivery.content.length < 500) {
    components = [new TextDisplayBuilder().setContent(`-# ${icons[tone]} ${delivery.content}${meta.hideHeader ? '' : ` · ${title}`}`)];
  } else {
    // Keep the body compact; a separate subtext footer stays outside code blocks
    // and gives replies a small attribution line without a heading or divider.
    const header = meta?.hideHeader ? '' : `**${title}**${meta?.subtitle ? ` · ${heading(meta.subtitle, 220)}` : ''}`;
    const text = [header, delivery.content].filter(Boolean).join('\n');
    const container = new ContainerBuilder().setAccentColor(tones[tone])
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(text || 'Codex'));
    const media = files.filter(f => f.kind === 'image' || f.kind === 'video');
    if (media.length) container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(media.map(f =>
      new MediaGalleryItemBuilder().setURL(`attachment://${f.name}`).setDescription(f.name))));
    for (const file of files.filter(f => f.kind === 'file')) container.addFileComponents(new FileBuilder().setURL(`attachment://${file.name}`));
    const notes = (delivery.artifactNotes ?? []).map(note => escapeMarkdown(note));
    const budget = Math.min(700, 3900 - text.length - (meta?.footer?.length ?? 0));
    if (notes.length && budget > 30) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(compact(notes.join('\n'), budget)));
    if (meta?.footer) container.addTextDisplayComponents(new TextDisplayBuilder()
      .setContent(`-# ${icons[tone]} ${heading(meta.footer, 180)}`));
    if (delivery.buttons?.length) container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(delivery.buttons.map(button =>
        new ButtonBuilder().setCustomId(button.id).setLabel(button.label)
          .setStyle(styles[button.style ?? (button.danger ? 'danger' : 'primary')]))));
    components = [container];
  }
  return { approvalReview: delivery.approvalReview,
    retained: retained.filter(r => files.some(f => f.hash === r.hash && f.name === r.name)), payload: {
    flags: MessageFlags.IsComponentsV2 as const,
    components,
    files: files.filter(file => !retained.some(r => r.hash === file.hash && r.name === file.name))
      .map(file => new AttachmentBuilder(file.data, { name: file.name })),
    allowedMentions: { parse: [] as const, repliedUser: false },
  } };
}

export function discordPayload(delivery: Delivery, artifacts: UploadFile[] = [], retained: UploadedFile[] = [], limits?: ArtifactConfig) {
  return prepareDiscordPayload(delivery, artifacts, retained, limits).payload;
}

/** V2 is irreversible per message; clear legacy text/embeds when converting an edit. */
export function prepareDiscordEditPayload(delivery: Delivery, artifacts: UploadFile[] = [], retained: UploadedFile[] = [], limits?: ArtifactConfig) {
  const prepared = prepareDiscordPayload(delivery, artifacts, retained, limits);
  return { approvalReview: prepared.approvalReview, payload: { ...prepared.payload, content: null, embeds: [],
    attachments: prepared.retained.map(r => ({ id: r.id, filename: r.name })) } };
}

export function discordEditPayload(delivery: Delivery, artifacts: UploadFile[] = [], retained: UploadedFile[] = [], limits?: ArtifactConfig) {
  return prepareDiscordEditPayload(delivery, artifacts, retained, limits).payload;
}
