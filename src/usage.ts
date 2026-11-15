import { escapeMarkdown } from 'discord.js';
import { card, compact } from './render.js';
import type { AccountRateLimits, Delivery, RateLimitSnapshot, RateLimitWindow, TokenUsageSnapshot } from './types.js';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const count = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value) && value >= 0;
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const label = (value: string) => escapeMarkdown(compact(value.replace(/\s+/g, ' '), 60));

/** Keep only reported counters, never turn missing values into zero. */
export function tokenUsageSnapshot(value: unknown, reportedAt = Math.floor(Date.now() / 1000)): TokenUsageSnapshot | null {
  const total = (value as { total?: TokenUsageSnapshot['total'] } | null)?.total;
  if (!total || !count(total.totalTokens) || !count(total.inputTokens) || !count(total.outputTokens)) return null;
  return { total: { totalTokens: total.totalTokens, inputTokens: total.inputTokens, outputTokens: total.outputTokens }, reportedAt };
}

function windowName(window: RateLimitWindow, fallback: string): string {
  const mins = window.windowDurationMins;
  if (!finite(mins) || mins <= 0) return fallback;
  if (mins === 10_080) return 'Weekly';
  if (mins === 1440) return 'Daily';
  if (mins % 1440 === 0) return `${number.format(mins / 1440)}-day`;
  if (mins % 60 === 0) return `${number.format(mins / 60)}-hour`;
  return `${number.format(mins)}-minute`;
}

function remaining(window: RateLimitWindow): number | null {
  return finite(window.usedPercent) ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : null;
}

function windowLines(window: RateLimitWindow, fallback: string, prefix: string, now: number): string {
  const left = remaining(window);
  const title = `${prefix}${windowName(window, fallback)} allowance`;
  if (left === null) return `**${title}** · Usage unavailable`;
  // Ten native emoji segments fit on mobile and render outside code formatting.
  // Floor segments so the bar never overstates the available allowance.
  const filled = Math.floor(left / 10);
  const color = left <= 10 ? '🟥' : left <= 20 ? '🟨' : '🟦';
  const bar = color.repeat(filled) + '⬛'.repeat(10 - filled);
  const percent = left > 0 && left < 0.1 ? '<0.1' : number.format(left < 100 ? Math.min(left, 99.9) : left);
  let reset = 'Reset time unavailable';
  if (count(window.resetsAt) && window.resetsAt > 0) {
    reset = window.resetsAt > now ? `Resets <t:${window.resetsAt}:R>` : 'Reset time passed · Run `/codex usage` to check again';
  }
  return `**${title} · ${percent}% left**\n${bar}\n-# ${reset}`;
}

/** A fresh account snapshot plus an independently timestamped session counter. */
export function usageCard(limits: AccountRateLimits | null, session?: TokenUsageSnapshot | null,
  unavailable?: string, now = Math.floor(Date.now() / 1000)): Delivery {
  const buckets = new Map<string, RateLimitSnapshot>();
  for (const [key, value] of Object.entries(limits?.rateLimitsByLimitId ?? {})) {
    if (value) buckets.set(value.limitId || key, value);
  }
  const legacy = limits?.rateLimits;
  if (legacy && !buckets.has(legacy.limitId || 'codex')) buckets.set(legacy.limitId || 'codex', legacy);
  const all = [...buckets.entries()];
  const windows = all.flatMap(([, bucket]) => [bucket.primary, bucket.secondary].filter((w): w is RateLimitWindow => !!w));
  const percentages = windows.map(remaining).filter((v): v is number => v !== null);
  const blocked = limits?.ordinaryUsageAllowed === false;
  const reached = all.some(([, b]) => b.spendControlReached || b.rateLimitReachedType);
  const tone = blocked || reached || percentages.some(p => p === 0) ? 'danger'
    : unavailable || !percentages.length || percentages.some(p => p <= 20) ? 'warning' : 'info';
  const lines: string[] = [];
  if (blocked) lines.push('**Included usage is currently blocked by an account limit.**');
  else if (reached) lines.push('**An account limit has been reached.**');
  if (unavailable) lines.push(unavailable);
  for (const [key, bucket] of all.slice(0, 4)) {
    const prefix = all.length > 1 || key !== 'codex' ? `${label(bucket.limitName || key)} · ` : '';
    if (bucket.primary) lines.push(windowLines(bucket.primary, 'Primary', prefix, now));
    if (bucket.secondary) lines.push(windowLines(bucket.secondary, 'Secondary', prefix, now));
    if (!bucket.primary && !bucket.secondary) lines.push(`**${label(bucket.limitName || key)}** · Allowance unavailable`);
  }
  if (!all.length && !unavailable) lines.push('Account allowance unavailable for this connection.');
  if (all.length > 4) lines.push(`-# ${all.length - 4} additional limit groups not shown.`);
  if (session) {
    lines.push(`**Session tokens · ${number.format(session.total.totalTokens)} used**\n-# ${number.format(session.total.inputTokens)} in · ${number.format(session.total.outputTokens)} out · Last reported <t:${session.reportedAt}:R>`);
  } else if (session === null) {
    lines.push('-# Session tokens will appear after the next usage update.');
  }
  return card(lines.join('\n\n'), { title: 'Codex usage', tone, footer: 'Host account · Shared across sessions' });
}
