import { ActionRowBuilder, ChannelType, Client,
  Events, GatewayIntentBits, MessageFlags, ModalBuilder, SlashCommandBuilder, TextInputBuilder,
  TextInputStyle, type Interaction, type Message, type TextChannel, type ThreadChannel } from 'discord.js';
import { basename } from 'node:path';
import { hostname } from 'node:os';
import type { Config } from './config.js';
import type { Bridge } from './bridge.js';
import { card, compact, deliveryNonce } from './render.js';
import { discordPayload, discordEditPayload } from './components.js';
import { Store } from './store.js';
import type { ChatPort, Delivery, Packet, Thread } from './types.js';

export class DiscordAdapter implements ChatPort {
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    allowedMentions: { parse: [], repliedUser: false } });
  private parent?: TextChannel;
  private bridge?: Bridge;
  private inboxTimer?: ReturnType<typeof setInterval>;
  private recovering = false;
  private closed = false;
  private buffered: Message[] = [];
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
      .addSubcommand(c => c.setName('status').setDescription('Show bridge status'));
    // Upsert our command by name; do not overwrite other commands on the application.
    await channel.guild.commands.create(command);
  }
  connect(bridge: Bridge): void {
    this.bridge = bridge;
    this.client.on(Events.MessageCreate, msg => {
      if (this.recovering) this.buffered.push(msg);
      else void this.receive(msg).catch(error => console.error(`Discord input: ${error}`));
    });
    this.client.on(Events.InteractionCreate, interaction => { void this.interact(interaction).catch(error => console.error(`Discord interaction: ${error}`)); });
    this.client.on(Events.Error, error => console.error(`Discord: ${error.message}`));
    void this.catchUp();
    this.inboxTimer = setInterval(() => { void this.catchUp(); }, 30_000);
  }
  async catchUp(): Promise<void> {
    if (this.recovering || this.closed || !this.bridge) return;
    this.recovering = true;
    try {
      for (const binding of this.store.bindings().filter(b => !b.parentThreadId)) {
        if (!this.bridge.eligible({ ...binding, id: binding.threadId, status: { type: '' } })) continue;
        try {
          const key = `inbox-cursor:${binding.channelId}`;
          // A Discord thread's snowflake is a natural lower boundary for its messages.
          let cursor = this.store.getMeta(key) ?? binding.channelId;
          const channel = await this.channel(binding.channelId, false);
          while (!this.closed) {
            const page = await channel.messages.fetch({ after: cursor, limit: 100 });
            const ordered = [...page.values()].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
            for (const msg of ordered) {
              await this.receive(msg);
              cursor = msg.id; this.store.setMeta(key, cursor);
            }
            if (page.size < 100) break;
          }
        } catch (error) { console.error(`Discord history recovery for ${binding.channelId}: ${error}`); }
      }
    } catch (error) { console.error(`Discord history recovery: ${error}`); }
    finally {
      this.recovering = false;
      for (const msg of this.buffered.splice(0)) {
        if (this.closed) break;
        await this.receive(msg).catch(error => console.error(`Discord input: ${error}`));
      }
    }
  }
  private async receive(msg: Message): Promise<void> {
    if (!this.bridge || msg.guildId !== this.config.guildId || msg.author.bot || msg.webhookId || !this.store.byChannel(msg.channelId)) return;
    if (!this.config.allowedUserIds.includes(msg.author.id)) return;
    if (!msg.content.trim()) {
      await msg.reply({ content: 'This version forwards text messages. Add text describing the attachment or task.', allowedMentions: { parse: [], repliedUser: false } });
      return;
    }
    try {
      const result = await this.bridge.serial(() => this.bridge!.submit(msg.channelId, msg.id, msg.author.id, msg.member?.displayName ?? msg.author.username, msg.content));
      if (result !== 'Already received') await msg.react(result.startsWith('Submission') ? '⚠️' : '📥');
    } catch (error) {
      await msg.reply({ content: compact(String(error)), allowedMentions: { parse: [], repliedUser: false } });
      throw error;
    }
  }
  private async interact(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;
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
      if (interaction.isButton() && interaction.customId.endsWith(':answer')) {
        if (!this.config.approverUserIds.includes(interaction.user.id)) throw new Error('You are not configured as an approver');
        const token = interaction.customId.split(':')[1]!;
        const approval = this.store.approval(token);
        if (!approval || approval.state !== 'pending' || approval.channel !== channelId || approval.epoch !== this.bridge!.codex.epoch) throw new Error('This prompt is no longer active');
        const p: Packet = JSON.parse(approval.packet);
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
      let result = 'Done';
      const bridge = this.bridge!;
      if (interaction.isChatInputCommand()) {
        const sub = interaction.options.getSubcommand();
        await bridge.serial(async () => {
          if (sub === 'sessions') {
            const sessions = await bridge.sessions();
            result = sessions.length ? sessions.map(t => `\`${t.id}\` · ${t.name || basename(t.cwd)} · ${t.status.type}`).join('\n') : 'No eligible loaded sessions';
          } else if (sub === 'attach') {
            const binding = await bridge.attach(interaction.options.getString('id', true)); result = `Connected: <#${binding.channelId}>`;
          } else if (sub === 'steer' || sub === 'stop') {
            await bridge.control(channelId, sub, interaction.options.getString('message') ?? undefined, interaction.user.id, interaction.user.username, interaction.id);
          } else result = `Codex: ${bridge.codex.connected ? 'connected' : 'reconnecting'}\nLinked agents: ${this.store.bindings().length}\nPending prompts: ${this.store.pendingApprovals().length}`;
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
      await interaction.editReply(discordEditPayload(card(result, { title: 'Codex', tone: 'info' })));
    } catch (error) {
      const content = compact(error instanceof Error ? error.message : String(error));
      if (interaction.deferred || interaction.replied) await interaction.editReply(discordEditPayload(card(content, { title: 'Unable to complete that action', tone: 'warning' })));
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  }
  async createThread(thread: Thread): Promise<string> {
    if (!this.parent) throw new Error('Discord is not ready');
    const key = `starter:${thread.id}`;
    let id = this.store.getMeta(key);
    if (!id) {
      const starter = await this.parent.send({ ...discordPayload(card(`**Project**\n\`${thread.cwd}\`\n\nOpen the thread below to follow this session or send instructions.`, {
        title: thread.name || basename(thread.cwd), subtitle: `Local session · ${hostname()}`, tone: 'info',
      })), nonce: deliveryNonce(key), enforceNonce: true });
      id = starter.id; this.store.setMeta(key, id);
    }
    const starter = await this.parent.messages.fetch(id);
    // A message-created thread has the starter message's ID, even if not cached.
    if (starter.hasThread) return starter.id;
    const created = await starter.startThread({ name: compact(`${thread.name || basename(thread.cwd)} · ${thread.id.slice(0, 8)}`, 100), autoArchiveDuration: 1440 });
    return created.id;
  }
  private async channel(id: string, activate = true): Promise<ThreadChannel> {
    const channel = await this.client.channels.fetch(id);
    if (!channel?.isThread() || channel.guildId !== this.config.guildId || channel.parentId !== this.config.channelId) throw new Error('Linked Discord thread is unavailable or outside the configured channel');
    if (activate && channel.archived && !channel.locked) await channel.setArchived(false);
    return channel;
  }
  async send(channelId: string, delivery: Delivery, nonce: string): Promise<string> {
    const channel = await this.channel(channelId);
    return (await channel.send({ ...discordPayload(delivery), nonce, enforceNonce: true })).id;
  }
  async edit(channelId: string, id: string, delivery: Delivery): Promise<void> {
    const channel = await this.channel(channelId);
    await channel.messages.edit(id, discordEditPayload(delivery));
  }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.inboxTimer);
    while (this.recovering) await Bun.sleep(25);
    await this.client.destroy();
  }
}
