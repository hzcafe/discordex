import { Store } from './store.js';
import { turnDelivery } from './render.js';
import type { Binding, Item, Packet, Turn, TurnState } from './types.js';

/** One durable presentation per agent turn; lifecycle events never reopen a final card. */
export class TurnCards {
  constructor(private store: Store) {}

  private selectedModel(binding: Binding): TurnState['model'] {
    return binding.model ? { name: binding.model, effort: binding.reasoningEffort ?? null, source: 'selected' } : null;
  }
  private initial(turnId: string): TurnState {
    return { turn: { id: turnId, status: 'inProgress', items: [] }, completedItemIds: [], lastItemId: null };
  }
  private publish(binding: Binding, state: TurnState): void {
    // Capture once while live, including upgrades of existing active cards.
    // Never backfill historical replies from today's session settings.
    if (state.model === undefined) state.model = state.turn.status === 'inProgress' ? this.selectedModel(binding) : null;
    const waiting = state.turn.status === 'inProgress' && this.store.pendingApprovals().some(a => {
      const packet: Packet = JSON.parse(a.packet);
      return a.threadId === binding.threadId && packet.params?.turnId === state.turn.id;
    });
    this.store.publishTurn(binding, state, turnDelivery(binding, state, waiting));
  }
  start(binding: Binding, turn: Turn): void {
    const state = this.store.turnState(binding.threadId, turn.id) ?? this.initial(turn.id);
    if (state.turn.status !== 'inProgress') return;
    state.turn = { ...state.turn, ...turn, items: state.turn.items };
    this.publish(binding, state);
  }
  item(binding: Binding, turnId: string, item: Item, completed: boolean): void {
    const state = this.store.turnState(binding.threadId, turnId) ?? this.initial(turnId);
    // A final assistant item can arrive after turn/completed. Accept its
    // authoritative content without allowing late activity to reopen the turn.
    if (state.turn.status !== 'inProgress' && !(completed && item.type === 'agentMessage')) return;
    const wasCompleted = state.completedItemIds.includes(item.id);
    if (wasCompleted && !completed) return;
    const items = state.turn.items!;
    const index = items.findIndex(i => i.id === item.id);
    if (index < 0) items.push(item); else items[index] = item;
    if (completed && !wasCompleted) state.completedItemIds.push(item.id);
    // Replayed completions must not replace a more recent activity indicator.
    if (!wasCompleted && item.type !== 'userMessage') state.lastItemId = item.id;
    this.publish(binding, state);
  }
  reconcile(binding: Binding, turn: Turn): void {
    const state = this.store.turnState(binding.threadId, turn.id) ?? this.initial(turn.id);
    if (state.turn.status !== 'inProgress' && turn.status === 'inProgress') return;
    if (turn.status !== 'inProgress') {
      state.turn = { ...state.turn, ...turn, items: turn.items ?? state.turn.items };
      state.completedItemIds = state.turn.items!.map(i => i.id);
    } else {
      // A live snapshot may contain unfinished assistant text. Only completion
      // events (or a completed turn) authorize showing it, including moderation.
      const items = state.turn.items!;
      for (const item of turn.items ?? []) {
        const index = items.findIndex(i => i.id === item.id);
        if (index < 0) {
          items.push(item);
          if (item.type !== 'userMessage') state.lastItemId = item.id;
        } else if (!state.completedItemIds.includes(item.id)) items[index] = item;
        if (['completed', 'failed', 'declined', 'interrupted'].includes(item.status) && !state.completedItemIds.includes(item.id)) {
          state.completedItemIds.push(item.id);
        }
      }
      state.turn = { ...state.turn, ...turn, items };
    }
    this.publish(binding, state);
  }
  complete(binding: Binding, turn: Turn): void {
    const state = this.store.turnState(binding.threadId, turn.id) ?? this.initial(turn.id);
    // Completion notifications can omit items or contain an empty list. Keep
    // the authoritative history/items already collected before finalizing.
    if (turn.items?.length) this.reconcile(binding, turn);
    else {
      state.turn = { ...state.turn, ...turn, items: state.turn.items };
      this.publish(binding, state);
    }
  }
  refresh(binding: Binding, turnId: string, create = false): void {
    const state = this.store.turnState(binding.threadId, turnId) ?? (create ? this.initial(turnId) : undefined);
    if (state) this.publish(binding, state);
  }
  rerouted(binding: Binding, turnId: string, model: string): void {
    const state = this.store.turnState(binding.threadId, turnId) ?? this.initial(turnId);
    // The reroute identifies the model, but does not report its reasoning effort.
    state.model = { name: model, effort: null, source: 'rerouted' };
    this.publish(binding, state);
  }
}
