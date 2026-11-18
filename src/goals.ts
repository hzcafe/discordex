import { escapeMarkdown } from 'discord.js';
import { card, compact } from './render.js';
import { Store } from './store.js';
import type { Binding, Button, CodexPort, Delivery, GoalCardState, GoalStatus, ThreadGoal } from './types.js';

export type GoalAction = 'create' | 'pause' | 'resume' | 'budget' | 'clear' | 'refresh';
export interface GoalInput { objective?: string; budget?: string }
const statuses: Record<GoalStatus, string> = { active: 'Active', paused: 'Paused', blocked: 'Blocked',
  usageLimited: 'Usage limited', budgetLimited: 'Budget reached', complete: 'Complete' };
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const actions: GoalAction[] = ['create', 'pause', 'resume', 'budget', 'clear', 'refresh'];

export function parseGoalControl(id: string): { threadId: string; version: string; action: GoalAction } {
  const parts = id.split(':');
  const [, , threadId, version, action] = parts;
  if (parts.length !== 5 || parts[0] !== 'dx' || parts[1] !== 'goal' || !threadId || !version || !actions.includes(action as GoalAction)) {
    throw new Error('Unknown goal control. Run `/codex goal` again.');
  }
  return { threadId, version, action: action as GoalAction };
}

export function parseGoalBudget(input: string | undefined): number | null {
  const text = (input ?? '').trim();
  if (!text) return null;
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0) {
    throw new Error('Token budget must be a positive whole number, or blank to remove the explicit budget.');
  }
  return Number(text);
}

function offered(goal: ThreadGoal | null): GoalAction[] {
  if (!goal) return ['create', 'refresh'];
  if (goal.status === 'complete') return ['create', 'clear', 'refresh'];
  return [goal.status === 'active' ? 'pause' : 'resume', 'budget', 'clear', 'refresh'];
}

function controls(state: GoalCardState): string {
  const g = state.goal;
  // Usage updates keep controls valid. Goal replacement, policy/status changes,
  // and reconnects invalidate buttons and any modals opened from them.
  return JSON.stringify([state.epoch, state.unavailable, g && [g.createdAt, g.objective, g.status, g.tokenBudget]]);
}

function elapsed(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${value % 60}s`;
  return `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m`;
}

export function goalCard(binding: Binding, state: GoalCardState): Delivery {
  const goal = state.goal;
  const lines: string[] = [];
  if (state.unavailable) lines.push(state.unavailable);
  if (goal) {
    lines.push(escapeMarkdown(compact(goal.objective, 900)));
    if (goal.tokenBudget !== null) {
      const left = Math.max(0, goal.tokenBudget - goal.tokensUsed);
      const percent = goal.tokenBudget > 0 ? Math.max(0, Math.min(100, left / goal.tokenBudget * 100)) : 0;
      const filled = Math.floor(percent / 10);
      const color = percent <= 10 ? '🟥' : percent <= 20 ? '🟨' : '🟦';
      lines.push(`**Goal budget · ${number.format(left)} tokens left**\n${color.repeat(filled)}${'⬛'.repeat(10 - filled)}\n-# ${number.format(goal.tokensUsed)} / ${number.format(goal.tokenBudget)} tokens used · ${elapsed(goal.timeUsedSeconds)}`);
    } else {
      lines.push(`-# ${number.format(goal.tokensUsed)} tokens used · ${elapsed(goal.timeUsedSeconds)} · No token budget`);
    }
    if (goal.status === 'paused') lines.push('-# Current work may still be running. Use `/codex stop` to interrupt it.');
    if (goal.status === 'budgetLimited') lines.push('-# Increase or remove the budget, then choose Resume.');
  } else if (!state.unavailable) lines.push('No goal set. Create one to have Codex work toward an objective.');
  const labels: Record<GoalAction, string> = { create: goal ? 'New goal' : 'Create goal', pause: 'Pause', resume: 'Resume', budget: 'Edit budget', clear: 'Clear', refresh: 'Refresh' };
  const buttons: Button[] = (state.unavailable ? ['refresh'] as GoalAction[] : offered(goal)).map(action => ({
    id: `dx:goal:${binding.threadId}:${state.version}:${action}`, label: labels[action],
    style: action === 'clear' ? 'danger' : action === 'create' || action === 'resume' ? 'primary' : 'secondary',
  }));
  const delivery = card(lines.join('\n\n'), { title: 'Codex goal', subtitle: state.unavailable ? (goal ? 'Last known state' : 'Unavailable') : goal ? statuses[goal.status] : 'Not set',
    tone: state.unavailable ? 'warning' : goal?.status === 'complete' ? 'success' : goal && goal.status !== 'active' ? 'warning' : 'info',
    footer: 'Goal budget · Separate from account allowance' }, 'goal.md', buttons);
  if (goal && goal.objective.length > 900) delivery.file = { name: 'goal.txt', content: goal.objective };
  return delivery;
}

export class Goals {
  constructor(private store: Store, private codex: CodexPort) {}

  private publish(binding: Binding, goal: ThreadGoal | null, force = false, unavailable?: string): GoalCardState | null {
    const previous = this.store.goalCard(binding.threadId);
    if (!goal && !previous && !force) return null;
    const state: GoalCardState = { goal, epoch: this.codex.epoch, version: previous?.version ?? '', unavailable };
    state.version = previous && controls(previous) === controls(state) ? previous.version : crypto.randomUUID().slice(0, 12);
    this.store.publishGoal(binding, state, goalCard(binding, state));
    return state;
  }
  unavailable(binding: Binding, message = 'Codex is reconnecting. Refresh after it reconnects.', force = false): void {
    const previous = this.store.goalCard(binding.threadId);
    if (previous || force) this.publish(binding, previous?.goal ?? null, true, message);
  }
  async read(binding: Binding, force = false): Promise<GoalCardState | null> {
    const epoch = this.codex.epoch;
    try {
      if (!this.codex.connected) throw new Error('Codex is reconnecting');
      const response = await this.codex.request<{ goal: ThreadGoal | null }>('thread/goal/get', { threadId: binding.threadId });
      if (epoch !== this.codex.epoch || !this.codex.connected) throw new Error('Codex reconnected during the goal read');
      if (response.goal === undefined || (response.goal && response.goal.threadId !== binding.threadId)) throw new Error('Invalid goal response');
      return this.publish(binding, response.goal, force);
    } catch (error) {
      this.unavailable(binding, 'Goal data is unavailable. Use Refresh to try again.', force);
      throw error;
    }
  }
  form(binding: Binding, version: string, action: 'create' | 'budget'): GoalCardState {
    const state = this.store.goalCard(binding.threadId);
    if (!this.codex.connected || !state || state.unavailable || state.epoch !== this.codex.epoch || state.version !== version || !offered(state.goal).includes(action)) {
      throw new Error('This goal control is out of date. Refresh the goal card and try again.');
    }
    return state;
  }
  async act(binding: Binding, version: string, action: GoalAction, input: GoalInput = {}): Promise<string> {
    const state = await this.read(binding, true);
    if (action === 'refresh') return 'Goal card refreshed.';
    if (!state || state.version !== version || !offered(state.goal).includes(action)) {
      throw new Error('The goal changed since this control was opened. Use the updated goal card.');
    }
    if (action === 'resume' && state.goal?.tokenBudget != null && state.goal.tokensUsed >= state.goal.tokenBudget) {
      throw new Error('This goal has used its token budget. Increase or remove the budget before resuming.');
    }
    const params: Record<string, unknown> = { threadId: binding.threadId, origin: 'user' };
    if (action === 'create') {
      const objective = input.objective?.trim();
      if (!objective || objective.length > 4000) throw new Error('Goal objective must contain 1–4,000 characters.');
      Object.assign(params, { objective, status: 'active', tokenBudget: parseGoalBudget(input.budget) });
    } else if (action === 'budget') params.tokenBudget = parseGoalBudget(input.budget);
    else if (action === 'pause' || action === 'resume') params.status = action === 'pause' ? 'paused' : 'active';
    const epoch = this.codex.epoch;
    try {
      if (action === 'clear') {
        const response = await this.codex.request<{ cleared: boolean }>('thread/goal/clear', params);
        if (epoch !== this.codex.epoch || !this.codex.connected) throw new Error('Codex disconnected during the goal action');
        if (typeof response.cleared !== 'boolean') throw new Error('Invalid goal clear response');
        this.publish(binding, null, true);
        return response.cleared ? 'Goal cleared. Use `/codex stop` to interrupt a running turn.' : 'There was no goal to clear.';
      } else {
        const response = await this.codex.request<{ goal: ThreadGoal }>('thread/goal/set', params);
        if (epoch !== this.codex.epoch || !this.codex.connected) throw new Error('Codex disconnected during the goal action');
        if (!response.goal || response.goal.threadId !== binding.threadId) throw new Error('Invalid goal response');
        this.publish(binding, response.goal, true);
        if (response.goal.status === 'paused' && action === 'pause') return 'Goal paused. Use `/codex stop` to interrupt a running turn.';
        const budget = action === 'budget' ? (response.goal.tokenBudget === null ? 'No token budget. ' : `Token budget set to ${number.format(response.goal.tokenBudget)}. `) : '';
        return `${budget}Goal status: ${statuses[response.goal.status]}.`;
      }
    } catch (error) {
      // Never replay a mutation after an uncertain reply. Read the daemon again.
      this.unavailable(binding, 'Goal action could not be confirmed. Refresh before trying again.');
      throw new Error(`Could not confirm the goal action. Refresh before retrying. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
