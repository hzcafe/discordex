import { relative, isAbsolute, basename } from 'node:path';
import type { Config } from './config.js';
import { RpcError } from './codex.js';
import { Store } from './store.js';
import { approvalDelivery, deliveryNonce, message, sessionCard } from './render.js';
import { TurnCards } from './turns.js';
import { tokenUsageSnapshot, usageCard } from './usage.js';
import { Goals, type GoalAction, type GoalInput } from './goals.js';
import type { AccountRateLimits, Binding, ChatPort, CodexPort, Delivery, Packet, Thread, Turn } from './types.js';

export class Bridge {
  private chain: Promise<unknown> = Promise.resolve();
  private flushing = false;
  private timer?: ReturnType<typeof setInterval>;
  private deliveryTimer?: ReturnType<typeof setInterval>;
  private subscribed = new Set<string>();
  private stopped = false;
  private listeners: { event: string; listener: (...args: any[]) => void }[] = [];
  private turns: TurnCards;
  private goals: Goals;

  constructor(readonly config: Config, readonly codex: CodexPort, readonly store: Store,
    private chat: ChatPort, private log: (text: string) => void = console.error) {
    this.turns = new TurnCards(store); this.goals = new Goals(store, codex);
  }

  // Codex notifications and human submissions share one ordering boundary.
  serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work);
    this.chain = result.catch(error => this.log(String(error)));
    return result;
  }
  start(): void {
    this.expireApprovals();
    this.invalidateGoals();
    for (const input of this.store.inputs()) if (input.state === 'submitting') this.store.inputState(input.id, 'unknown');
    this.listen('ready', () => { void this.serial(() => this.sync()); });
    this.listen('disconnected', () => { this.subscribed.clear(); this.expireApprovals(); this.invalidateGoals(); });
    this.listen('notification', (packet: Packet) => {
      const epoch = this.codex.epoch;
      void this.serial(() => epoch === this.codex.epoch ? this.notification(packet) : Promise.resolve());
    });
    this.listen('serverRequest', (packet: Packet) => {
      const epoch = this.codex.epoch;
      void this.serial(() => epoch === this.codex.epoch && this.codex.connected ? this.serverRequest(packet) : Promise.resolve());
    });
    this.timer = setInterval(() => { void this.serial(() => this.sync()); }, 15_000);
    this.deliveryTimer = setInterval(() => { void this.flush(); }, 1000);
    if (this.codex.connected) void this.serial(() => this.sync());
  }
  private listen(event: string, listener: (...args: any[]) => void): void {
    this.listeners.push({ event, listener }); this.codex.on(event, listener);
  }
  async stop(): Promise<void> {
    this.stopped = true; clearInterval(this.timer); clearInterval(this.deliveryTimer);
    for (const { event, listener } of this.listeners) this.codex.off(event, listener);
    this.listeners = [];
    await this.chain;
    while (this.flushing) await Bun.sleep(25);
  }
  eligible(thread: Thread): boolean {
    return !this.config.projectRoots.length || this.config.projectRoots.some(root => {
      const path = relative(root, thread.cwd);
      return path === '' || (path !== '..' && !path.startsWith('../') && !isAbsolute(path));
    });
  }
  private invalidateGoals(): void {
    for (const binding of this.store.bindings()) {
      if (!binding.parentThreadId && this.eligible({ ...binding, id: binding.threadId, status: { type: '' } })) this.goals.unavailable(binding);
    }
  }
  private goalBinding(channelId: string, userId: string, threadId?: string): Binding {
    if (!this.config.allowedUserIds.includes(userId)) throw new Error('You are not configured to control Codex');
    const binding = this.requireBinding(channelId);
    if (threadId && threadId !== binding.threadId) throw new Error('This goal control belongs to a different session');
    return binding;
  }
  async showGoal(channelId: string, userId: string): Promise<void> {
    await this.goals.read(this.goalBinding(channelId, userId), true);
  }
  goalForm(channelId: string, userId: string, threadId: string, version: string, action: 'create' | 'budget') {
    return this.goals.form(this.goalBinding(channelId, userId, threadId), version, action);
  }
  async goalAction(channelId: string, userId: string, threadId: string, version: string, action: GoalAction, input?: GoalInput): Promise<string> {
    return this.goals.act(this.goalBinding(channelId, userId, threadId), version, action, input);
  }
  async usage(channelId: string, userId: string): Promise<Delivery> {
    if (!this.config.allowedUserIds.includes(userId)) throw new Error('You are not configured to control this bot');
    const binding = this.store.byChannel(channelId);
    if (channelId !== this.config.channelId && !binding) throw new Error('Use the configured Codex channel or a linked thread');
    if (binding && !this.eligible({ ...binding, id: binding.threadId, status: { type: '' } })) throw new Error('This project is outside the configured projectRoots');
    const session = binding ? this.store.tokenUsage(binding.threadId) : undefined;
    let limits: AccountRateLimits | null = null;
    let unavailable: string | undefined;
    if (!this.codex.connected) unavailable = 'Codex is reconnecting. Run `/codex usage` again shortly.';
    else {
      const epoch = this.codex.epoch;
      try {
        const response = await this.codex.request<AccountRateLimits>('account/rateLimits/read', { excludeResetCreditDetails: true });
        if (epoch !== this.codex.epoch || !this.codex.connected) throw new Error('Codex reconnected during the usage read');
        limits = response;
      } catch (error) {
        this.log(`Cannot read account limits: ${error}`);
        unavailable = error instanceof RpcError && error.code === -32601
          ? 'Account limits are not available from this Codex daemon.'
          : 'Account limits are unavailable for this connection. Try `/codex usage` again shortly.';
      }
    }
    return usageCard(limits, session, unavailable);
  }
  async sessions(): Promise<Thread[]> {
    const result: Thread[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: string[]; nextCursor?: string | null } = await this.codex.request('thread/loaded/list', { cursor, limit: 100 });
      for (const threadId of page.data) {
        try {
          const { thread } = await this.codex.request<{ thread: Thread }>('thread/read', { threadId });
          if (this.eligible(thread)) result.push(thread);
        } catch (error) { this.log(`Cannot inspect ${threadId}: ${error}`); }
      }
      cursor = page.nextCursor ?? null;
    } while (cursor);
    return result;
  }
  async attach(threadId: string, ancestry = new Set<string>()): Promise<Binding> {
    if (ancestry.has(threadId)) throw new Error('Cyclic Codex parent relationship');
    ancestry.add(threadId);
    const { thread } = await this.codex.request<{ thread: Thread }>('thread/read', { threadId });
    if (!this.eligible(thread)) throw new Error('This project is outside the configured projectRoots');
    let binding = this.store.binding(threadId);
    if (!binding) {
      const page = await this.codex.request<{ data: Turn[] }>('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded' });
      const active = page.data.find(t => t.status === 'inProgress');
      const parent = thread.parentThreadId ? await this.attach(thread.parentThreadId, ancestry) : undefined;
      const channelId = parent?.channelId ?? await this.chat.createThread(thread);
      binding = { threadId, channelId, parentThreadId: thread.parentThreadId ?? null,
        label: thread.agentNickname || thread.name || basename(thread.cwd) || 'Codex', cwd: thread.cwd,
        since: Date.now() / 1000,
        initialTurnId: active?.id ?? null, checkpoint: page.data.find(t => t.status !== 'inProgress')?.id ?? null };
      this.store.saveBinding(binding);
      this.store.enqueue(`attached:${threadId}`, channelId, sessionCard(binding));
    }
    this.saveModelSettings(binding, thread.model, thread.reasoningEffort);
    await this.subscribe(binding);
    return binding;
  }
  private async subscribe(binding: Binding): Promise<void> {
    if (this.subscribed.has(binding.threadId)) return;
    const response = await this.codex.request<{ thread: Thread; model?: string; reasoningEffort?: string | null }>('thread/resume', { threadId: binding.threadId, excludeTurns: true });
    this.saveModelSettings(binding, response.model ?? response.thread.model, response.reasoningEffort ?? response.thread.reasoningEffort);
    this.subscribed.add(binding.threadId);
  }
  private saveModelSettings(binding: Binding, model?: string | null, effort?: string | null): void {
    binding.model = model ?? null;
    binding.reasoningEffort = effort ?? null;
    this.store.saveBinding(binding);
  }
  async sync(): Promise<void> {
    if (this.stopped || !this.codex.connected) return;
    if (this.config.autoDiscover) for (const thread of await this.sessions()) {
      try { await this.attach(thread.id); } catch (error) { this.log(`Attach ${thread.id}: ${error}`); }
    }
    for (const binding of this.store.bindings()) {
      if (!this.eligible({ ...binding, id: binding.threadId, status: { type: '' } })) continue;
      try {
        await this.subscribe(binding);
        await this.reconcile(binding);
        if (!binding.parentThreadId) await this.drainInputs(binding);
      } catch (error) { this.log(`Sync ${binding.threadId}: ${error}`); }
      if (!binding.parentThreadId) {
        try { await this.goals.read(binding); }
        catch (error) { this.log(`Goal sync ${binding.threadId}: ${error}`); }
      }
    }
    void this.flush();
  }
  private withinBoundary(binding: Binding, turn: Turn): boolean {
    return turn.id === binding.initialTurnId || (turn.completedAt ?? turn.startedAt ?? Infinity) >= binding.since;
  }
  async reconcile(binding: Binding): Promise<void> {
    const turns: Turn[] = [];
    let cursor: string | null = null;
    let done = false;
    do {
      const page: { data: Turn[]; nextCursor?: string | null } = await this.codex.request('thread/turns/list', {
        threadId: binding.threadId, cursor, limit: 50, itemsView: 'full', sortDirection: 'desc' });
      for (const turn of page.data) {
        if (turn.id === binding.checkpoint) { done = true; break; }
        if (!this.withinBoundary(binding, turn)) { done = true; break; }
        turns.push(turn);
      }
      cursor = page.nextCursor ?? null;
    } while (cursor && !done);
    for (const turn of turns.reverse()) {
      for (const item of turn.items ?? []) {
        this.store.saveItem(binding.threadId, item);
        if (item.type === 'userMessage' && item.clientId) this.confirmInput(item.clientId);
      }
      this.turns.reconcile(binding, turn);
      if (turn.status !== 'inProgress') {
        this.completeTurn(binding, turn);
        binding.checkpoint = turn.id;
      }
    }
    this.store.saveBinding(binding);
  }
  private completeTurn(binding: Binding, turn: Turn): void {
    this.turns.complete(binding, turn);
    for (const approval of this.store.pendingApprovals()) {
      const packet: Packet = JSON.parse(approval.packet);
      if (approval.threadId === binding.threadId && packet.params?.turnId === turn.id) this.finishApproval(approval.token, 'resolved');
    }
  }
  async notification(packet: Packet): Promise<void> {
    const p = packet.params ?? {};
    if (packet.method === 'serverRequest/resolved') {
      const approval = this.store.resolveApproval(this.codex.epoch, p.requestId);
      if (approval) this.finishApproval(approval.token, 'resolved');
      return;
    }
    if (packet.method === 'thread/started' && this.config.autoDiscover && this.eligible(p.thread)) {
      if (!this.store.binding(p.thread.id)) await this.attach(p.thread.id);
      return;
    }
    const binding = this.store.binding(p.threadId);
    if (!binding || !this.eligible({ ...binding, id: binding.threadId, status: { type: '' } })) return;
    if (packet.method === 'thread/goal/updated' || packet.method === 'thread/goal/cleared') {
      // Read the authoritative snapshot: delayed notifications must not restore
      // a replaced goal or clear a newer one created in another client.
      if (!binding.parentThreadId) await this.goals.read(binding);
    } else if (packet.method === 'thread/tokenUsage/updated') {
      const usage = tokenUsageSnapshot(p.tokenUsage);
      if (usage) this.store.saveTokenUsage(binding.threadId, usage);
    } else if (packet.method === 'item/started' || packet.method === 'item/completed') {
      this.store.saveItem(binding.threadId, p.item);
      if (p.item.type === 'userMessage' && p.item.clientId) this.confirmInput(p.item.clientId);
      this.turns.item(binding, p.turnId, p.item, packet.method === 'item/completed');
    } else if (packet.method === 'turn/completed') {
      // The completion payload need not contain items; hydrate durable history first.
      await this.reconcile(binding);
      this.completeTurn(binding, p.turn);
      if (!binding.parentThreadId) await this.drainInputs(binding);
    } else if (packet.method === 'turn/started') {
      // The live read captures selected settings; it does not assert execution
      // identity. Later settings changes are only used for subsequent cards.
      try {
        const { thread } = await this.codex.request<{ thread: Thread }>('thread/read', { threadId: binding.threadId });
        this.saveModelSettings(binding, thread.model, thread.reasoningEffort);
      } catch (error) {
        this.saveModelSettings(binding, null, null);
        this.log(`Cannot read model settings for ${binding.threadId}: ${error}`);
      }
      this.turns.start(binding, p.turn);
    } else if (packet.method === 'thread/settings/updated') {
      this.saveModelSettings(binding, p.threadSettings?.model, p.threadSettings?.effort);
    } else if (packet.method === 'model/rerouted' && typeof p.turnId === 'string' && typeof p.toModel === 'string') {
      this.turns.rerouted(binding, p.turnId, p.toModel);
    } else if (packet.method === 'thread/name/updated' && typeof p.threadName === 'string') {
      binding.label = p.threadName; this.store.saveBinding(binding);
    }
  }
  async serverRequest(packet: Packet): Promise<void> {
    const binding = this.store.binding(packet.params?.threadId);
    if (!binding || !this.eligible({ ...binding, id: binding.threadId, status: { type: '' } })) return;
    const snapshot = this.store.item(binding.threadId, packet.params!.itemId);
    if (packet.method === 'item/commandExecution/requestApproval' && snapshot?.type === 'commandExecution') {
      packet.params!.command ??= snapshot.command;
      packet.params!.cwd ??= snapshot.cwd;
    }
    if (packet.method === 'item/fileChange/requestApproval') {
      const item = this.store.item(binding.threadId, packet.params!.itemId);
      if (item?.changes?.length) packet.params!.discordexDiff = item.changes.map((c: any) => `${c.path}\n${c.diff ?? ''}`).join('\n');
    }
    const approval = this.store.addApproval(this.codex.epoch, packet, binding.channelId);
    this.store.enqueue(`approval:${approval.token}`, binding.channelId, approvalDelivery(approval, binding));
    if (packet.params?.turnId) this.turns.refresh(binding, packet.params.turnId, true);
    void this.flush();
  }
  private finishApproval(token: string, state: string): void {
    this.store.approvalState(token, state);
    const approval = this.store.approval(token)!;
    const binding = this.store.binding(approval.threadId);
    this.store.revise(`approval:${token}`, approvalDelivery(approval, binding));
    const packet: Packet = JSON.parse(approval.packet);
    if (binding && packet.params?.turnId) this.turns.refresh(binding, packet.params.turnId);
  }
  private expireApprovals(): void { for (const a of this.store.pendingApprovals()) this.finishApproval(a.token, 'expired'); }
  async decide(token: string, action: string, channelId: string, userId: string, answers?: Record<string, string>): Promise<void> {
    if (!this.config.approverUserIds.includes(userId)) throw new Error('You are not configured as an approver');
    const a = this.store.approval(token);
    if (!a || a.channel !== channelId || a.state !== 'pending' || a.epoch !== this.codex.epoch || !this.codex.connected) throw new Error('This prompt is no longer active');
    this.requireBinding(channelId);
    const p: Packet = JSON.parse(a.packet);
    if (!approvalDelivery(a).buttons?.some(b => b.id === `dx:${token}:${action}`)) throw new Error('This decision is not offered for this request');
    let result: unknown;
    if (action === 'answer') {
      const values: Record<string, { answers: string[] }> = {};
      for (const q of p.params!.questions) {
        if (!answers?.[q.id]?.trim()) throw new Error('Every question needs an answer');
        values[q.id] = { answers: [answers[q.id]!] };
      }
      result = { answers: values };
    } else if (p.method === 'item/permissions/requestApproval') {
      const permissions = action === 'accept' ? Object.fromEntries(Object.entries(p.params!.permissions).filter(([, v]) => v !== null)) : {};
      result = { permissions, scope: 'turn' };
    } else result = { decision: action };
    this.finishApproval(token, 'submitted');
    try { await this.codex.respond(p.id!, result); }
    catch (error) { this.finishApproval(token, 'expired'); throw error; }
  }
  async submit(channelId: string, id: string, userId: string, name: string, text: string): Promise<string> {
    if (!this.config.allowedUserIds.includes(userId)) throw new Error('You are not configured to send messages to Codex');
    const binding = this.requireBinding(channelId);
    if (!text.trim()) throw new Error('The message is empty');
    if (!this.store.addInput(id, binding.threadId, `[Discord: ${name.replace(/[\r\n]/g, ' ')}; user ID: ${userId}]\n${text}`)) return 'Already received';
    try { await this.drainInputs(binding); }
    catch (error) { this.log(`Submission saved for reconnect: ${error}`); }
    const input = this.store.inputs(binding.threadId).find(i => i.id === id)!;
    return input.state === 'unknown' ? 'Submission outcome is uncertain. Check the session before resending.' : input.state === 'new' ? 'Saved locally; waiting for Codex to become available' : 'Queued for Codex';
  }
  private confirmInput(id: string): void {
    this.store.inputState(id, 'delivered');
    this.store.revise(`uncertain:${id}`, message(`Delivery confirmed for Discord message ${id}. No need to resend it.`));
  }
  private async queuedInputs(threadId: string): Promise<{ id: string; clientUserMessageId: string }[]> {
    const queuedItems: { id: string; clientUserMessageId: string }[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: typeof queuedItems; nextCursor?: string | null } = await this.codex.request('thread/queue/list', { threadId, cursor, limit: 100 });
      queuedItems.push(...page.data); cursor = page.nextCursor ?? null;
    } while (cursor);
    return queuedItems;
  }
  private async drainInputs(binding: Binding): Promise<void> {
    if (!this.codex.connected) return;
    const { thread } = await this.codex.request<{ thread: Thread }>('thread/read', { threadId: binding.threadId });
    if (thread.canAcceptDirectInput === false) return;
    const queuedItems = await this.queuedInputs(binding.threadId);
    for (const input of this.store.inputs(binding.threadId)) {
      if (input.state === 'delivered') { this.confirmInput(input.id); continue; }
      const queued = queuedItems.find(q => q.clientUserMessageId === input.id);
      if (queued) this.store.inputState(input.id, 'queued', queued.id);
      else if (input.state === 'submitting' || input.state === 'unknown') {
        this.store.inputState(input.id, 'unknown');
        this.store.enqueue(`uncertain:${input.id}`, binding.channelId, message(`Could not confirm delivery of Discord message ${input.id}. Check Codex history before resending it.`));
      } else if (input.state === 'new') {
        this.store.inputState(input.id, 'submitting');
        try {
          const response = await this.codex.request<{ queuedSubmission: { id: string } }>('thread/queue/add', {
            threadId: binding.threadId, clientUserMessageId: input.id, input: [{ type: 'text', text: input.text, text_elements: [] }] });
          this.store.inputState(input.id, 'queued', response.queuedSubmission.id);
        } catch (error) { this.store.inputState(input.id, 'unknown'); this.log(`Input ${input.id}: ${error}`); }
      }
      // An acknowledged queue entry can disappear before its userMessage arrives.
      // Keep that acceptance; only history or an item event confirms consumption.
    }
    // queue/add can immediately wake another client. Refresh both snapshots before
    // starting a remaining entry; never start an ID from the pre-submission snapshot.
    const remaining = await this.queuedInputs(binding.threadId);
    const { thread: current } = await this.codex.request<{ thread: Thread }>('thread/read', { threadId: binding.threadId });
    if (current.status.type === 'idle') {
      const first = this.store.inputs(binding.threadId).find(i => i.state === 'queued' && remaining.some(q => q.id === i.queueId));
      if (first) {
        try { await this.codex.request('thread/queue/start', { threadId: binding.threadId, queuedSubmissionId: first.queueId }); this.confirmInput(first.id); }
        catch (error) {
          // Another client may still win between the fresh snapshots and this RPC.
          if (error instanceof RpcError && error.message.startsWith('queued submission not found:')) await this.reconcile(binding);
          else this.log(`Queue start ${first.id}: ${error}`);
        }
      }
    }
  }
  async control(channelId: string, action: 'steer' | 'stop', text?: string, userId?: string, name?: string, interactionId?: string): Promise<void> {
    if (!userId || !this.config.allowedUserIds.includes(userId)) throw new Error('You are not configured to control Codex');
    const binding = this.requireBinding(channelId);
    const page = await this.codex.request<{ data: Turn[] }>('thread/turns/list', { threadId: binding.threadId, limit: 1, itemsView: 'notLoaded' });
    const turn = page.data.find(t => t.status === 'inProgress');
    if (!turn) throw new Error('This session has no active turn');
    if (action === 'stop') await this.codex.request('turn/interrupt', { threadId: binding.threadId, turnId: turn.id });
    else {
      if (!text?.trim()) throw new Error('Steering needs a message');
      await this.codex.request('turn/steer', { threadId: binding.threadId, expectedTurnId: turn.id, clientUserMessageId: interactionId,
        input: [{ type: 'text', text: `[Discord: ${name}; user ID: ${userId}]\n${text}`, text_elements: [] }] });
    }
  }
  private requireBinding(channelId: string): Binding {
    const binding = this.store.byChannel(channelId);
    if (!binding) throw new Error('Use this command inside a linked Discord thread');
    if (!this.eligible({ ...binding, id: binding.threadId, status: { type: '' } })) throw new Error('This project is outside the configured projectRoots');
    return binding;
  }
  async flush(): Promise<void> {
    if (this.flushing || this.stopped) return;
    this.flushing = true;
    try {
      const failedChannels = new Set<string>();
      for (const row of this.store.outgoing()) {
        if (failedChannels.has(row.channel)) continue;
        try {
          const delivery = JSON.parse(row.payload);
          if (row.message) { await this.chat.edit(row.channel, row.message, delivery); this.store.delivered(row, row.message); }
          else {
            const nonce = deliveryNonce(row.key);
            this.store.delivered(row, await this.chat.send(row.channel, delivery, nonce));
          }
        } catch (error) { failedChannels.add(row.channel); this.store.retry(row); this.log(`Discord delivery failed: ${error}`); }
      }
    } finally { this.flushing = false; }
  }
}
