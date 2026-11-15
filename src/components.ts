import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder,
  FileBuilder, MessageFlags, TextDisplayBuilder, escapeMarkdown } from 'discord.js';
import type { Delivery } from './types.js';
import { compact } from './render.js';

const tones = { neutral: 0x7b8497, info: 0x7289da, success: 0x3ba55d, warning: 0xf0b232, danger: 0xed4245 };
const icons = { neutral: '•', info: '◦', success: '✓', warning: '◼', danger: '✕' };
const styles = { primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary, success: ButtonStyle.Success, danger: ButtonStyle.Danger };
const heading = (value: string, limit: number) => compact(escapeMarkdown(value.replace(/[\r\n]+/g, ' ')), limit);

/** Serialize both new cards and persisted legacy deliveries using Components V2. */
export function discordPayload(delivery: Delivery) {
  const meta = delivery.card;
  const tone = meta?.tone ?? 'info';
  const title = heading(meta?.title ?? 'Codex', 180);
  let components: (ContainerBuilder | TextDisplayBuilder)[];
  if (meta?.compact && !meta.footer && !delivery.file && !delivery.buttons?.length && delivery.content.length < 500) {
    components = [new TextDisplayBuilder().setContent(`-# ${icons[tone]} ${delivery.content}${meta.hideHeader ? '' : ` · ${title}`}`)];
  } else {
    // Keep the body compact; a separate subtext footer stays outside code blocks
    // and gives replies a small attribution line without a heading or divider.
    const header = meta?.hideHeader ? '' : `**${title}**${meta?.subtitle ? ` · ${heading(meta.subtitle, 220)}` : ''}`;
    const text = [header, delivery.content].filter(Boolean).join('\n');
    const container = new ContainerBuilder().setAccentColor(tones[tone])
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(text || 'Codex'));
    if (delivery.file) container.addFileComponents(new FileBuilder().setURL(`attachment://${delivery.file.name}`));
    if (meta?.footer) container.addTextDisplayComponents(new TextDisplayBuilder()
      .setContent(`-# ${icons[tone]} ${heading(meta.footer, 180)}`));
    if (delivery.buttons?.length) container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(delivery.buttons.map(button =>
        new ButtonBuilder().setCustomId(button.id).setLabel(button.label)
          .setStyle(styles[button.style ?? (button.danger ? 'danger' : 'primary')]))));
    components = [container];
  }
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components,
    files: delivery.file ? [new AttachmentBuilder(Buffer.from(delivery.file.content), { name: delivery.file.name })] : [],
    allowedMentions: { parse: [] as const, repliedUser: false },
  };
}

/** V2 is irreversible per message; clear legacy text/embeds when converting an edit. */
export function discordEditPayload(delivery: Delivery) {
  return { ...discordPayload(delivery), content: null, embeds: [], attachments: [] };
}
