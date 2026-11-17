import { ActionRowBuilder, ChannelType, Client, ComponentType,
  Events, GatewayIntentBits, MessageFlags, ModalBuilder, SlashCommandBuilder, TextInputBuilder,
  TextInputStyle, type APIMessageComponent, type APIUnfurledMediaItem,
  type Interaction, type Message, type TextChannel, type ThreadChannel } from 'discord.js';
import { basename } from 'node:path';
import { hostname } from 'node:os';
import type { Config } from './config.js';
import type { Bridge } from './bridge.js';
import { card, compact, deliveryNonce } from './render.js';
import { approvalControls } from './approvals.js';
import { deliveryFiles, discordPayload, discordEditPayload, prepareDiscordPayload, prepareDiscordEditPayload } from './components.js';
import { parseGoalControl } from './goals.js';
import { modelPickerPayload, parseModelControl } from './models.js';
import { InputCapacityError, Store } from './store.js';
import { hasIncomingMedia, type IncomingMedia, MediaRetryError, prepareIncomingMedia } from './inbound-media.js';
import { InboundMediaCache } from './inbound-cache.js';
import { discordNotFound, MissingMessageError, MissingThreadError, temporaryUploadFailure } from './chat.js';
import { artifactUploads } from './artifacts.js';
import { rejectedReviewNotice, retryingReviewNotice, withoutGeneratedFile } from './uploads.js';
import type { ChatPort, Delivery, DeliveryReceipt, Packet, Thread, UploadedFile, UploadFile } from './types.js';

const uploadRejected = (error: unknown) => typeof error === 'object' && error !== null &&
  (('status' in error && error.status === 413) || ('code' in error && [40005, 50035, 50045, 50146].includes(Number(error.code))));
const withoutFiles = (delivery: Delivery, retrying: boolean): Delivery => ({ ...withoutGeneratedFile(delivery), artifacts: undefined,
  artifactNotes: [...delivery.artifactNotes ?? [], ...(delivery.file?.requiredForActions
    ? [retrying ? retryingReviewNotice : rejectedReviewNotice]
    : [retrying ? 'Attachments are temporarily unavailable. Discordex is retrying automatically; you do not need to do anything.'
      : 'Discord rejected the file upload; the text reply is shown here.',
      ...(!retrying && delivery.file ? ['Full text is available in the local Codex session.'] : [])])] });

/** V2 file/gallery uploads may be present only in components, with an empty attachments collection. */
function messageFiles(message: Message): { id: string; name: string }[] {
  const files = [...message.attachments?.values() ?? []].map(a => ({ id: a.id, name: a.name }));
  const media = (item: APIUnfurledMediaItem) => {
    if (!item.attachment_id) return;
    try {
      const name = decodeURIComponent(new URL(item.url).pathname.split('/').at(-1)!);
      if (name) files.push({ id: item.attachment_id, name });
    } catch { /* An unusable URL cannot identify an uploaded filename. */ }
  };
  const visit = (component: APIMessageComponent) => {
    if (component.type === ComponentType.File) media(component.file);
    else if (component.type === ComponentType.MediaGallery) component.items.forEach(item => media(item.media));
    if ('components' in component) component.components.forEach(visit);
  };
  for (const component of message.components ?? []) visit(component.toJSON());
  return files;
}

export class DiscordAdapter implements ChatPort {
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    allowedMentions: { parse: [], repliedUser: false } });
  private parent?: TextChannel;
  private bridge?: Bridge;
  private inboxTimer?: ReturnType<typeof setInterval>;
  private recovery?: Promise<void>;
  private closed = false;
  private buffered = new Map<string, Message[]>();
  private nonTextReplies = new Map<string, Promise<void>>();
  private incoming = new Map<string, Promise<void>>();
  private channelInputs = new Map<string, Promise<void>>();
  private mediaCache?: InboundMediaCache;
  private get media(): InboundMediaCache { return this.mediaCache ??= new InboundMediaCache(this.store, this.config.stateDir, this.config.inbound); }
  constructor(private config: Config, private store: Store) {}

  async login(token: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    let onReady: () => void;
    let onError: (error: Error) => void;
    let onDisconnect: (event: { code: number }) => void;
    const ready = new Promise<void>((resolve, reject) => {
      onReady = resolve;
      onError = reject;
      onDisconnect = event => {
        if (event.code === 4014) reject(new Error('Enable Message Content Intent in the Discord Developer Portal bot settings, then restart Discordex'));
        else if (event.code === 4004) reject(new Error('Discord rejected the bot token'));
        else if (event.code === 4013) reject(new Error('Discord rejected the requested Gateway intents'));
      };
      timer = setTimeout(() => reject(new Error('Discord Gateway connection timed out')), 30_000);
      this.client.once(Events.ClientReady, onReady);
      this.client.once(Events.Error, onError);
      this.client.on(Events.ShardDisconnect, onDisconnect);
    });
    try { await Promise.all([this.client.login(token), ready]); }
    finally {
      clearTimeout(timer!);
      this.client.off(Events.ClientReady, onReady!);
      this.client.off(Events.Error, onError!);
      this.client.off(Events.ShardDisconnect, onDisconnect!);
    }
    const channel = await this.client.channels.fetch(this.config.channelId);
    if (channel?.type !== ChannelType.GuildText || channel.guildId !== this.config.guildId) throw new Error('channelId must identify a text channel in the configured guild');
    this.parent = channel;
    const command = new SlashCommandBuilder().setName('codex').setDescription('Manage your local Codex sessions')
      .addSubcommand(c => c.setName('sessions').setDescription('List loaded sessions'))
      .addSubcommand(c => c.setName('attach').setDescription('Link an existing Codex session').addStringOption(o => o.setName('id').setDescription('Codex thread ID').setRequired(true)))
      .addSubcommand(c => c.setName('steer').setDescription('Send instructions into the active turn now').addStringOption(o => o.setName('message').setDescription('Instructions for Codex').setRequired(true)))
      .addSubcommand(c => c.setName('stop').setDescription('Interrupt the active turn'))
      .addSubcommand(c => c.setName('usage').setDescription('Show remaining account allowance and session token usage'))
      .addSubcommand(c => c.setName('model').setDescription('Choose this session’s model and reasoning effort'))
      .addSubcommand(c => c.setName('goal').setDescription('Show and manage this session’s shared goal card'))
      .addSubcommand(c => c.setName('status').setDescription('Show bridge status'));
    // Upsert our command by name; do not overwrite other commands on the application.
    await channel.guild.commands.create(command);
  }
  connect(bridge: Bridge): void {
    this.bridge = bridge;
    this.client.on(Events.MessageCreate, msg => {
      const buffer = this.buffered.get(msg.channelId);
      if (buffer) buffer.push(msg);
      else void this.receive(msg).catch(error => console.error(`Discord input: ${error}`));
    });
    this.client.on(Events.InteractionCreate, interaction => { void this.interact(interaction).catch(error => console.error(`Discord interaction: ${error}`)); });
    this.client.on(Events.Error, error => console.error(`Discord: ${error.message}`));
    this.client.on(Events.ThreadDelete, channel => {
      if (this.closed || channel.guildId !== this.config.guildId || channel.parentId !== this.config.channelId) return;
      void bridge.serial(() => bridge.recoverChannel(channel.id)).catch(error => console.error(`Discord thread recovery: ${error}`));
    });
    void this.catchUp();
    this.inboxTimer = setInterval(() => { void this.catchUp(); }, 30_000);
  }
  catchUp(): Promise<void> {
    if (this.recovery) return this.recovery;
    if (this.closed || !this.bridge) return Promise.resolve();
    this.recovery = this.recoverInbox().finally(() => { this.recovery = undefined; });
    return this.recovery;
  }
  private async recoverInbox(): Promise<void> {
    try {
      const results = await Promise.allSettled(this.store.bindings().filter(b => !b.parentThreadId).map(async binding => {
        if (!this.bridge!.eligible({ ...binding, id: binding.threadId, status: { type: '' } })) return;
        const buffer: Message[] = [];
        this.buffered.set(binding.channelId, buffer);
        try {
          const key = `inbox-cursor:${binding.channelId}`;
          // A Discord thread's snowflake is a natural lower boundary for its messages.
          let cursor = this.store.getMeta(key) ?? binding.channelId;
          const channel = await this.channel(binding.channelId, false, true);
          while (!this.closed) {
            const page = await channel.messages.fetch({ after: cursor, limit: 100 });
            const ordered = [...page.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
            for (const msg of ordered) {
              if (this.closed) break;
              await this.receive(msg);
              cursor = msg.id; this.store.setMeta(key, cursor);
            }
            if (page.size < 100) break;
          }
        } catch (error) {
          if (!this.closed && error instanceof MissingThreadError) {
            await this.bridge!.serial(() => this.bridge!.recoverChannel(binding.channelId))
              .catch(error => console.error(`Discord thread recovery for ${binding.channelId}: ${error}`));
          } else console.error(`Discord history recovery for ${binding.channelId}: ${error}`);
        } finally {
          // Keep this channel gated until its whole backlog is drained; other
          // channels can deliver while this one's history/download is pending.
          while (!this.closed && buffer.length) await this.receive(buffer.shift()!).catch(error => console.error(`Discord input: ${error}`));
          this.buffered.delete(binding.channelId);
        }
      }));
      for (const result of results) if (result.status === 'rejected') console.error(`Discord history recovery: ${result.reason}`);
    } catch (error) { console.error(`Discord history recovery: ${error}`); }
  }
  private receive(msg: Message): Promise<void> {
    if (this.closed || !this.bridge || msg.guildId !== this.config.guildId || msg.author.bot || msg.webhookId) return Promise.resolve();
    const binding = this.store.byChannel(msg.channelId);
    if (!binding || !this.config.allowedUserIds.includes(msg.author.id)) return Promise.resolve();
    if (this.bridge.eligible && !this.bridge.eligible({ ...binding, id: binding.threadId, status: { type: '' } })) return Promise.resolve();
    if (this.store.hasInput(msg.id)) {
      // A crash after saving the input but before updating its status must not
      // leave a permanent "waiting for images" notice on history recovery.
      this.mediaReceived(msg.id);
      return Promise.resolve();
    }
    const existing = this.incoming.get(msg.id);
    if (existing) return existing;
    const prior = this.channelInputs.get(msg.channelId);
    const work = prior ? prior.catch(() => {}).then(() => this.receiveInput(msg)) : this.receiveInput(msg);
    const pending = work.finally(() => {
      this.incoming.delete(msg.id);
      if (this.channelInputs.get(msg.channelId) === pending) this.channelInputs.delete(msg.channelId);
    });
    this.incoming.set(msg.id, pending);
    this.channelInputs.set(msg.channelId, pending);
    return pending;
  }
  private mediaReceived(id: string): void {
    this.store.revise(`input-media-retry:${id}`, card('The message is saved for Codex. Any unavailable media is identified in the forwarded message.', { title: 'Message received' }));
  }
  private async receiveInput(msg: Message): Promise<void> {
    if (!msg.content.trim() && !msg.attachments?.size && !msg.embeds?.length) {
      // Unlike text submissions, warnings have no input row to deduplicate them.
      // Share in-flight replies and persist success without moving the history cursor.
      const key = `non-text-reply:${msg.id}`;
      if (this.store.getMeta(key)) return;
      let pending = this.nonTextReplies.get(msg.id);
      if (!pending) {
        pending = Promise.resolve().then(async () => {
          await msg.reply({ content: 'This message has no text or supported image attachment to forward.',
            nonce: deliveryNonce(key), enforceNonce: true, allowedMentions: { parse: [], repliedUser: false } });
          this.store.setMeta(key, 'sent');
        }).finally(() => { this.nonTextReplies.delete(msg.id); });
        this.nonTextReplies.set(msg.id, pending);
      }
      await pending;
      return;
    }
    try {
      // Media work is bounded and runs outside the bridge queue, so downloads do
      // not hold up approval decisions or Codex events.
      const media: IncomingMedia = hasIncomingMedia(msg)
        ? await this.media.run(() => prepareIncomingMedia(msg, fetch, { cache: this.media, inputId: msg.id }))
        : { images: [], notes: [], warnings: [] };
      const text = () => [msg.content, ...(media.notes.length ? [`[Discord media]\n${media.notes.join('\n')}`] : [])].filter(Boolean).join('\n\n');
      if (!text().trim() && !media.images.length) return;
      const result = await this.bridge!.serial(async () => {
        const submit = () => this.bridge!.submit(msg.channelId, msg.id, msg.author.id,
          msg.member?.displayName ?? msg.author.username, text(), media.images);
        try { return await submit(); }
        catch (error) {
          if (!(error instanceof InputCapacityError) || !media.originals?.length) throw error;
          media.images = [];
          media.notes = media.notes.filter(note => !/^Image \d+:/.test(note));
          const warning = 'Image preview storage is full; the saved original files are available for analysis.';
          media.notes.push(warning); media.warnings.push(warning);
          return await submit();
        }
      });
      this.mediaReceived(msg.id);
      if (media.warnings.length) this.store.enqueue(`input-media-notes:${msg.id}`, msg.channelId,
        card(`Some media or previews were unavailable. Codex received the details, saved file paths, and available links.\n\n${media.warnings.join('\n')}`, { title: 'Media input', tone: 'warning' }));
      if (result !== 'Already received') await msg.react(result.startsWith('Submission') || media.warnings.length ? '⚠️' : '📥');
    } catch (error) {
      if (error instanceof MediaRetryError || error instanceof InputCapacityError) {
        this.store.enqueue(`input-media-retry:${msg.id}`, msg.channelId,
          card('This message is waiting for its media. Discordex will retry automatically; you do not need to resend it.', { title: 'Media delayed', tone: 'warning' }));
        throw error; // Leave the history cursor before this message for automatic retry.
      }
      await msg.reply({ content: compact(String(error)), allowedMentions: { parse: [], repliedUser: false } });
      throw error;
    }
  }
  private async interact(interaction: Interaction): Promise<void> {
    if (this.closed) return;
    if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isModalSubmit() && !interaction.isStringSelectMenu?.()) return;
    if (interaction.isChatInputCommand() && interaction.commandName !== 'codex') return;
    if (!interaction.isChatInputCommand() && !interaction.customId.startsWith('dx:')) return;
    if (interaction.guildId !== this.config.guildId || !this.config.allowedUserIds.includes(interaction.user.id)) {
      await interaction.reply({ content: 'You are not configured to control this bot.', flags: MessageFlags.Ephemeral }); return;
    }
    const channelId = interaction.channelId!;
    if (channelId !== this.config.channelId && !this.store.byChannel(channelId)) {
      await interaction.reply({ content: 'Use the configured Codex channel or a linked thread.', flags: MessageFlags.Ephemeral }); return;
    }
    try {
      if (interaction.isChatInputCommand() ? interaction.options.getSubcommand() === 'model' : interaction.customId.startsWith('dx:model:')) {
        await this.interactModel(interaction); return;
      }
      if (interaction.isStringSelectMenu?.()) return;
      if (interaction.isChatInputCommand() ? interaction.options.getSubcommand() === 'goal' : interaction.customId.startsWith('dx:goal:')) {
        await this.interactGoal(interaction); return;
      }
      if (interaction.isButton() && interaction.customId.endsWith(':answer')) {
        if (!this.config.approverUserIds.includes(interaction.user.id)) throw new Error('You are not configured as an approver');
        const token = interaction.customId.split(':')[1]!;
        const approval = this.store.approval(token);
        if (!approval || approval.state !== 'pending' || approval.channel !== channelId || approval.epoch !== this.bridge!.codex.epoch) throw new Error('This prompt is no longer active');
        const p: Packet = JSON.parse(approval.packet);
        if (!approvalControls(approval).includes('answer')) throw new Error('The full input request has not been delivered here. Its prompt card explains the delivery status.');
        const modal = new ModalBuilder().setCustomId(`dx:${token}:answer`).setTitle('Answer Codex');
        for (const [index, q] of p.params!.questions.entries()) {
          modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder()
            .setCustomId(String(index)).setLabel(compact(q.header || q.question, 45))
            .setPlaceholder(compact((q.options ?? []).map((o: any) => o.label).join(' / ') || q.question, 100))
            .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)));
        }
        await interaction.showModal(modal); return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (this.closed) throw new Error('Discordex is shutting down. Try this action again after it reconnects.');
      let result = 'Done';
      let delivery: Delivery | undefined;
      const bridge = this.bridge!;
      if (interaction.isChatInputCommand()) {
        const sub = interaction.options.getSubcommand();
        // This read can wait on the account service without delaying approvals or turns.
        if (sub === 'usage') delivery = await bridge.usage(channelId, interaction.user.id);
        else await bridge.serial(async () => {
          if (sub === 'sessions') {
            const sessions = await bridge.sessions();
            result = sessions.length ? sessions.map(t => `\`${t.id}\` · ${t.name || basename(t.cwd)} · ${t.status.type}`).join('\n') : 'No eligible loaded sessions';
          } else if (sub === 'attach') {
            const binding = await bridge.attach(interaction.options.getString('id', true)); result = `Connected: <#${binding.channelId}>`;
          } else if (sub === 'steer' || sub === 'stop') {
            await bridge.control(channelId, sub, interaction.options.getString('message') ?? undefined, interaction.user.id, interaction.user.username, interaction.id);
          } else if (sub === 'retry') result = 'Delivery recovery is automatic now. No retry command is needed.';
          else result = `Codex: ${bridge.codex.connected ? 'connected' : 'reconnecting'}\nLinked agents: ${this.store.bindings().length}\nPending prompts: ${this.store.pendingApprovals().length}\nBlocked deliveries: ${this.store.blockedDeliveries().length}`;
        });
      } else {
        const [, token, action] = interaction.customId.split(':');
        let answers: Record<string, string> | undefined;
        if (interaction.isModalSubmit()) {
          const approval = this.store.approval(token!);
          if (!approval) throw new Error('Unknown prompt');
          const packet: Packet = JSON.parse(approval.packet);
          answers = Object.fromEntries(packet.params!.questions.map((q: any, i: number) => [q.id, interaction.fields.getTextInputValue(String(i))]));
        }
        await bridge.serial(() => bridge.decide(token!, action!, channelId, interaction.user.id, answers));
        result = 'Response sent to Codex';
      }
      await interaction.editReply(discordEditPayload(delivery ?? card(result, { title: 'Codex', tone: 'info' }), [], [], this.config.artifacts));
    } catch (error) {
      const content = compact(error instanceof Error ? error.message : String(error));
      if (interaction.deferred || interaction.replied) await interaction.editReply(discordEditPayload(card(content, { title: 'Unable to complete that action', tone: 'warning' }), [], [], this.config.artifacts));
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  }
  private async interactModel(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu()) return;
    const bridge = this.bridge!;
    if (interaction.isChatInputCommand()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (this.closed) throw new Error('Discordex is shutting down. Try this action again after it reconnects.');
      const picker = await bridge.modelPicker(interaction.channelId!, interaction.user.id);
      await interaction.editReply(modelPickerPayload(picker));
    } else {
      const control = parseModelControl(interaction.customId);
      if (interaction.isStringSelectMenu() !== ['model', 'effort'].includes(control.action)) throw new Error('Unknown model control. Run `/codex model` again.');
      await interaction.deferUpdate();
      if (this.closed) throw new Error('Discordex is shutting down. Try this action again after it reconnects.');
      const picker = await bridge.modelAction(interaction.channelId!, interaction.user.id, control.token, control.revision,
        control.action, interaction.isStringSelectMenu() ? interaction.values[0] : undefined);
      await interaction.editReply(modelPickerPayload(picker));
    }
  }
  private async interactGoal(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;
    const bridge = this.bridge!;
    const channelId = interaction.channelId!;
    const control = interaction.isChatInputCommand() ? null : parseGoalControl(interaction.customId);
    if (interaction.isButton() && control && (control.action === 'create' || control.action === 'budget')) {
      // Opening a modal must be the initial response. Cached validation is fast;
      // submission checks the current daemon state again before any mutation.
      const state = bridge.goalForm(channelId, interaction.user.id, control.threadId, control.version, control.action);
      const modal = new ModalBuilder().setCustomId(interaction.customId)
        .setTitle(control.action === 'create' ? 'Create Codex goal' : 'Edit goal budget');
      if (control.action === 'create') modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('objective').setLabel('Objective (starts work immediately)')
          .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000)));
      const budget = new TextInputBuilder().setCustomId('budget').setLabel('Total token budget (optional)')
        .setPlaceholder('Blank removes the explicit budget; host limits still apply')
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(16);
      if (control.action === 'budget' && state.goal?.tokenBudget !== null && state.goal?.tokenBudget !== undefined) budget.setValue(String(state.goal.tokenBudget));
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(budget));
      await interaction.showModal(modal); return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (this.closed) throw new Error('Discordex is shutting down. Try this action again after it reconnects.');
    let result = 'Goal card updated.';
    await bridge.serial(async () => {
      if (!control) await bridge.showGoal(channelId, interaction.user.id);
      else {
        const input: { objective?: string; budget?: string } = {};
        if (interaction.isModalSubmit()) {
          if (control.action !== 'create' && control.action !== 'budget') throw new Error('Unknown goal form');
          input.budget = interaction.fields.getTextInputValue('budget');
          if (control.action === 'create') input.objective = interaction.fields.getTextInputValue('objective');
        }
        result = await bridge.goalAction(channelId, interaction.user.id, control.threadId, control.version, control.action, input);
      }
    });
    await bridge.flush();
    const binding = this.store.byChannel(channelId)!;
    const messageId = this.store.messageId(`goal:${binding.threadId}`);
    result += messageId ? ` [Open goal card](https://discord.com/channels/${this.config.guildId}/${channelId}/${messageId}).` : ' The shared card will appear in this thread.';
    await interaction.editReply(discordEditPayload(card(result, { title: 'Codex goal', tone: 'info', compact: true, hideHeader: true }), [], [], this.config.artifacts));
  }
  async createThread(thread: Thread, replacingChannelId?: string): Promise<string> {
    if (!this.parent) throw new Error('Discord is not ready');
    // Each deleted channel gets its own durable creation attempt. A crash before
    // rebinding can reuse the replacement starter without creating another thread.
    const base = `starter:${thread.id}${replacingChannelId ? `:replacement:${replacingChannelId}` : ''}`;
    for (let attempt = 0; ; attempt++) {
      const key = this.store.getMeta(`${base}:generation`) ?? base;
      let id = this.store.getMeta(key);
      if (id) {
        // Deleting a starter message need not delete its thread. Reuse the
        // surviving thread even if fetching that message would now return 404.
        try { await this.checkThread(id); return id; }
        catch (error) { if (!(error instanceof MissingThreadError) || error.channelId !== id) throw error; }
      }
      if (!id) {
        const starter = await this.parent.send({ ...discordPayload(card(`**Project**\n\`${thread.cwd}\`\n\nOpen the thread below to follow this session or send instructions.`, {
          title: thread.name || basename(thread.cwd), subtitle: `Local session · ${hostname()}`, tone: 'info',
        }), [], [], this.config.artifacts), nonce: deliveryNonce(key), enforceNonce: true });
        id = starter.id; this.store.setMeta(key, id);
      }
      try {
        const starter = await this.parent.messages.fetch({ message: id, force: true });
        // A message-created thread has the starter's ID; cached flags can outlive it.
        if (starter.hasThread) { await this.checkThread(id); return id; }
        try {
          const created = await starter.startThread({ name: compact(`${thread.name || basename(thread.cwd)} · ${thread.id.slice(0, 8)}`, 100), autoArchiveDuration: 1440 });
          return created.id;
        } catch (error) {
          // The thread may have been created just before a lost response/restart.
          if (typeof error === 'object' && error !== null && 'code' in error && error.code === 160004) {
            await this.checkThread(id); return id;
          }
          throw error;
        }
      } catch (error) {
        if (!discordNotFound(error, 10008) && !(error instanceof MissingThreadError && error.channelId === id)) throw error;
        // A new nonce is needed even if the saved starter was deleted immediately.
        this.store.setMeta(`${base}:generation`, `${base}:${crypto.randomUUID()}`);
        if (attempt >= 1) throw error;
      }
    }
  }
  async checkThread(channelId: string): Promise<void> { await this.channel(channelId, false, true); }
  private async channel(id: string, activate = true, force = false): Promise<ThreadChannel> {
    let channel;
    try { channel = await this.client.channels.fetch(id, { force }); }
    catch (error) {
      if (discordNotFound(error, 10003)) throw new MissingThreadError(id);
      throw error;
    }
    if (!channel?.isThread() || channel.guildId !== this.config.guildId || channel.parentId !== this.config.channelId) throw new Error('Linked Discord thread is unavailable or outside the configured channel');
    if (activate && channel.archived && !channel.locked) await channel.setArchived(false);
    return channel;
  }
  private rememberFiles(channelId: string, message: Message, delivery: Delivery, files: UploadFile[]): void {
    const uploaded: UploadedFile[] = [];
    const available = messageFiles(message);
    for (const file of deliveryFiles(delivery, files, this.config.artifacts)) {
      const attachment = available.find(a => a.name === file.name);
      if (attachment) uploaded.push({ name: file.name, hash: file.hash, id: attachment.id });
    }
    this.store.setMeta(`attachments:${channelId}:${message.id}`, JSON.stringify(uploaded));
  }
  async send(channelId: string, delivery: Delivery, nonce: string): Promise<string | (DeliveryReceipt & { id: string })> {
    try {
      const channel = await this.channel(channelId);
      let prepared = artifactUploads(this.store, delivery);
      let plan = prepareDiscordPayload(prepared.delivery, prepared.files, [], this.config.artifacts);
      let retryAttachments = false;
      let sent: Message;
      try { sent = await channel.send({ ...plan.payload, nonce, enforceNonce: true }); }
      catch (error) {
        retryAttachments = temporaryUploadFailure(error);
        if ((!uploadRejected(error) && !retryAttachments) || !deliveryFiles(prepared.delivery, prepared.files, this.config.artifacts).length) throw error;
        console.error(`Discord file upload rejected: ${compact(String(error), 1000)}`);
        prepared = { delivery: withoutFiles(prepared.delivery, retryAttachments), files: [] };
        plan = prepareDiscordPayload(prepared.delivery, [], [], this.config.artifacts);
        sent = await channel.send({ ...plan.payload, nonce, enforceNonce: true });
      }
      this.rememberFiles(channelId, sent, prepared.delivery, prepared.files);
      return plan.approvalReview || retryAttachments ? { id: sent.id, approvalReview: plan.approvalReview,
        ...(retryAttachments ? { retryAttachments: true } : {}) } : sent.id;
    } catch (error) {
      if (discordNotFound(error, 10003)) throw new MissingThreadError(channelId);
      throw error;
    }
  }
  async edit(channelId: string, id: string, delivery: Delivery): Promise<DeliveryReceipt> {
    try {
      const channel = await this.channel(channelId);
      let retained: UploadedFile[] = JSON.parse(this.store.getMeta(`attachments:${channelId}:${id}`) ?? '[]');
      if (retained.length) {
        const current = await channel.messages.fetch({ message: id, force: true });
        const available = messageFiles(current);
        retained = retained.filter(r => available.some(a => a.id === r.id && a.name === r.name));
      }
      let prepared = artifactUploads(this.store, delivery, retained);
      let plan = prepareDiscordEditPayload(prepared.delivery, prepared.files, retained, this.config.artifacts);
      let retryAttachments = false;
      let edited: Message;
      try { edited = await channel.messages.edit(id, plan.payload); }
      catch (error) {
        retryAttachments = temporaryUploadFailure(error);
        if ((!uploadRejected(error) && !retryAttachments) || !deliveryFiles(prepared.delivery, prepared.files, this.config.artifacts).length) throw error;
        console.error(`Discord file upload rejected: ${compact(String(error), 1000)}`);
        prepared = { delivery: withoutFiles(prepared.delivery, retryAttachments), files: [] };
        plan = prepareDiscordEditPayload(prepared.delivery, [], [], this.config.artifacts);
        edited = await channel.messages.edit(id, plan.payload);
      }
      // Test adapters and legacy clients may not return a full Discord message.
      if (edited) this.rememberFiles(channelId, edited, prepared.delivery, prepared.files);
      return { approvalReview: plan.approvalReview, ...(retryAttachments ? { retryAttachments: true } : {}) };
    } catch (error) {
      if (discordNotFound(error, 10003)) throw new MissingThreadError(channelId);
      if (discordNotFound(error, 10008)) throw new MissingMessageError(channelId, id);
      throw error;
    }
  }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.inboxTimer);
    await this.recovery;
    await Promise.allSettled(this.incoming.values());
    await Promise.allSettled(this.nonTextReplies.values());
    await this.client.destroy();
  }
}
