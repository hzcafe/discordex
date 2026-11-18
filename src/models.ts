import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, MessageFlags,
  StringSelectMenuBuilder, TextDisplayBuilder, escapeMarkdown } from 'discord.js';
import { compact } from './render.js';
import type { Binding, CodexPort, Thread } from './types.js';

export interface ModelOption {
  id: string; model: string; displayName: string; description: string; hidden: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
}
type Settings = { model: string | null; effort: string | null; provider: string | null };
export type ModelAction = 'model' | 'effort' | 'prev' | 'next' | 'refresh' | 'apply';
export interface ModelPicker {
  token: string; revision: number; userId: string; threadId: string; channelId: string; epoch: string; expiresAt: number;
  current: Settings; models: ModelOption[]; selected: number; effort: string | null; page: number; notice?: string;
}
const expired = () => new Error('This model picker is out of date. Run `/codex model` again.');
const settings = (thread: Thread & { modelProvider?: string }): Settings => ({ model: thread.model ?? null,
  effort: thread.reasoningEffort ?? null, provider: thread.modelProvider ?? null });
const sameSettings = (a: Settings, b: Settings) => a.model === b.model && a.effort === b.effort && a.provider === b.provider;
function selectedEffort(model: ModelOption | undefined, preferred: string | null): string | null {
  const options = model?.supportedReasoningEfforts ?? [];
  return options.find(o => o.reasoningEffort === preferred)?.reasoningEffort
    ?? options.find(o => o.reasoningEffort === model?.defaultReasoningEffort)?.reasoningEffort
    ?? null;
}
function index(value: string | undefined, length: number): number {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) >= length) throw new Error('Unknown model or effort selection. Run `/codex model` again.');
  return Number(value);
}
export function parseModelControl(id: string): { token: string; revision: number; action: ModelAction } {
  const [prefix, kind, token, revision, action, extra] = id.split(':');
  if (prefix !== 'dx' || kind !== 'model' || !token || !/^\d+$/.test(revision ?? '') || extra !== undefined
    || !['model', 'effort', 'prev', 'next', 'refresh', 'apply'].includes(action ?? '')) throw expired();
  return { token, revision: Number(revision), action: action as ModelAction };
}

/** Private, short-lived drafts. Selecting an option never writes session settings. */
export class Models {
  private pickers = new Map<string, ModelPicker>();
  constructor(private codex: CodexPort, private eligible: (thread: Thread) => boolean) {}
  private connection(epoch: string): void {
    if (!this.codex.connected || this.codex.epoch !== epoch) throw new Error('Codex reconnected. Run `/codex model` again.');
  }
  private async read(binding: Binding, epoch: string): Promise<Settings> {
    this.connection(epoch);
    const { thread } = await this.codex.request<{ thread: Thread & { modelProvider?: string } }>('thread/read', { threadId: binding.threadId });
    this.connection(epoch);
    if (thread.id !== binding.threadId || !this.eligible(thread)) throw new Error('This project is outside the configured projectRoots');
    return settings(thread);
  }
  private async catalog(provider: string | null, epoch: string): Promise<ModelOption[]> {
    const models = new Map<string, ModelOption>();
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      this.connection(epoch);
      const page: { data: ModelOption[]; nextCursor?: string | null } = await this.codex.request('model/list', {
        cursor, limit: 100, includeHidden: false, ...(provider ? { modelProvider: provider } : {}),
      });
      this.connection(epoch);
      for (const model of page.data) if (!model.hidden) models.set(model.model, model);
      cursor = page.nextCursor ?? null;
      if (cursor && seen.has(cursor)) throw new Error('The model list could not be loaded. Try `/codex model` again.');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return [...models.values()];
  }
  private remember(binding: Binding, userId: string, epoch: string, current: Settings, models: ModelOption[], notice?: string): ModelPicker {
    for (const [token, picker] of this.pickers) if (picker.expiresAt <= Date.now() || picker.epoch !== epoch) this.pickers.delete(token);
    if (this.pickers.size >= 200) this.pickers.delete(this.pickers.keys().next().value!);
    const selected = models.findIndex(m => m.model === current.model);
    const picker: ModelPicker = { token: crypto.randomUUID(), revision: 0, userId, threadId: binding.threadId,
      channelId: binding.channelId, epoch, expiresAt: Date.now() + 15 * 60_000, current, models, selected,
      effort: models[selected]?.supportedReasoningEfforts.find(o => o.reasoningEffort === current.effort)?.reasoningEffort ?? null,
      page: Math.max(0, Math.floor(selected / 25)), notice };
    this.pickers.set(picker.token, picker);
    return structuredClone(picker);
  }
  async open(binding: Binding, userId: string): Promise<ModelPicker> {
    const epoch = this.codex.epoch;
    const current = await this.read(binding, epoch);
    const models = await this.catalog(current.provider, epoch);
    return this.remember(binding, userId, epoch, current, models);
  }
  async act(binding: Binding, userId: string, token: string, revision: number, action: ModelAction, value?: string): Promise<ModelPicker> {
    const picker = this.pickers.get(token);
    if (!picker || picker.userId !== userId || picker.threadId !== binding.threadId || picker.channelId !== binding.channelId
      || picker.revision !== revision || picker.expiresAt <= Date.now()) throw expired();
    this.connection(picker.epoch);
    // Claim this revision before awaiting anything; duplicate Apply clicks cannot write twice.
    picker.revision++;
    picker.notice = undefined;
    if (action === 'model') {
      const selected = index(value, picker.models.length);
      if (Math.floor(selected / 25) !== picker.page) throw expired();
      picker.selected = selected;
      picker.effort = selectedEffort(picker.models[selected], picker.effort);
    } else if (action === 'effort') {
      const efforts = picker.models[picker.selected]?.supportedReasoningEfforts ?? [];
      picker.effort = efforts[index(value, efforts.length)]!.reasoningEffort;
    } else if (action === 'prev' || action === 'next') {
      picker.page = Math.max(0, Math.min(Math.ceil(picker.models.length / 25) - 1, picker.page + (action === 'next' ? 1 : -1)));
    } else if (action === 'refresh') {
      this.pickers.delete(token);
      return this.open(binding, userId);
    } else if (action === 'apply') {
      this.pickers.delete(token);
      const chosen = picker.models[picker.selected];
      if (!chosen) throw new Error('Choose a model before applying. Run `/codex model` again.');
      const models = await this.catalog(picker.current.provider, picker.epoch);
      const current = await this.read(binding, picker.epoch);
      if (!sameSettings(current, picker.current)) throw new Error('Session settings changed since this picker opened. Run `/codex model` again to see them.');
      const available = models.find(m => m.model === chosen.model);
      if (!available || (picker.effort !== null && !available.supportedReasoningEfforts.some(o => o.reasoningEffort === picker.effort))) {
        throw new Error('That model or effort is no longer available. Run `/codex model` again.');
      }
      if (current.model === chosen.model && (picker.effort === null || current.effort === picker.effort)) {
        return this.remember(binding, userId, picker.epoch, current, models, 'These settings are already active.');
      }
      // No retry after an uncertain response: the daemon may have accepted it.
      try {
        this.connection(picker.epoch);
        await this.codex.request('thread/settings/update', { threadId: binding.threadId, model: chosen.model,
          ...(picker.effort !== null ? { effort: picker.effort } : {}) });
        const confirmed = await this.read(binding, picker.epoch);
        if (confirmed.provider !== current.provider || confirmed.model !== chosen.model ||
          (picker.effort !== null && confirmed.effort !== picker.effort)) throw new Error('Different settings reported');
        return this.remember(binding, userId, picker.epoch, confirmed, models, 'Saved for subsequent turns. Any current turn keeps its existing settings.');
      } catch {
        throw new Error('Could not confirm the model change. Run `/codex model` to check the current settings before trying again.');
      }
    }
    return structuredClone(picker);
  }
}

export function modelPickerPayload(picker: ModelPicker) {
  const id = (action: ModelAction) => `dx:model:${picker.token}:${picker.revision}:${action}`;
  const selected = picker.models[picker.selected];
  const pages = Math.max(1, Math.ceil(picker.models.length / 25));
  const models = picker.models.slice(picker.page * 25, (picker.page + 1) * 25);
  const modelMenu = new StringSelectMenuBuilder().setCustomId(id('model'))
    .setPlaceholder(pages > 1 ? `Model · page ${picker.page + 1}/${pages}` : 'Model').setDisabled(!models.length)
    .addOptions(models.length ? models.map((m, i) => ({ label: compact(m.displayName || m.model, 100), value: String(picker.page * 25 + i),
      ...(m.description ? { description: compact(m.description, 100) } : {}), default: picker.selected === picker.page * 25 + i }))
      : [{ label: 'No models available', value: 'none' }]);
  const efforts = selected?.supportedReasoningEfforts ?? [];
  const effortMenu = new StringSelectMenuBuilder().setCustomId(id('effort')).setPlaceholder('Reasoning effort').setDisabled(!efforts.length)
    .addOptions(efforts.length ? efforts.map((o, i) => ({ label: compact(o.reasoningEffort, 100), value: String(i),
      ...(o.description ? { description: compact(o.description, 100) } : {}), default: picker.effort === o.reasoningEffort }))
      : [{ label: selected ? 'No reasoning options' : 'Choose a model first', value: 'none' }]);
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(id('apply')).setLabel('Apply').setStyle(ButtonStyle.Primary).setDisabled(!selected),
    new ButtonBuilder().setCustomId(id('refresh')).setLabel('Refresh').setStyle(ButtonStyle.Secondary));
  if (pages > 1) buttons.addComponents(
    new ButtonBuilder().setCustomId(id('prev')).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(!picker.page),
    new ButtonBuilder().setCustomId(id('next')).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(picker.page === pages - 1));
  const current = `${picker.current.model ?? 'Unknown model'} · ${picker.current.effort ?? 'Effort not reported'}`;
  const offPage = selected && Math.floor(picker.selected / 25) !== picker.page
    ? `\nSelected: ${escapeMarkdown(compact(`${selected.displayName || selected.model} · ${picker.effort ?? 'No effort selected'}`, 160))}` : '';
  const container = new ContainerBuilder().setAccentColor(0x7289da)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Session model**\nCurrent: ${escapeMarkdown(compact(current, 160))}${offPage}\n${picker.notice ?? 'Choose a model and effort, then Apply. Changes affect subsequent turns.'}`))
    .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modelMenu))
    .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(effortMenu))
    .addActionRowComponents(buttons);
  return { flags: MessageFlags.IsComponentsV2 as const, components: [container], allowedMentions: { parse: [] as const } };
}
