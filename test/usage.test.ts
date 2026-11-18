import { expect, test } from 'bun:test';
import { discordPayload } from '../src/components.js';
import { tokenUsageSnapshot, usageCard } from '../src/usage.js';
import type { AccountRateLimits, RateLimitWindow } from '../src/types.js';

const now = 1_800_000_000;
const window = (usedPercent: number, windowDurationMins = 10_080): RateLimitWindow => ({ usedPercent, windowDurationMins, resetsAt: now + 3600 });
const limits = (usedPercent: number): AccountRateLimits => ({ rateLimits: { limitId: 'codex', primary: window(usedPercent) } });

test('the allowance bar shows remaining quota and derives its label from the actual window', () => {
  const delivery = usageCard(limits(35), undefined, undefined, now);
  expect(delivery.content).toContain('Weekly allowance · 65% left');
  expect(delivery.content).toContain('\n🟦🟦🟦🟦🟦🟦⬛⬛⬛⬛\n');
  expect(delivery.content).toContain(`Resets <t:${now + 3600}:R>`);
  expect(delivery.content).not.toContain('Session tokens');
  expect(delivery.card?.footer).toBe('Host account · Shared across sessions');
  expect(usageCard({ rateLimits: { primary: window(10, 300), secondary: window(80) } }, null).content)
    .toContain('5-hour allowance · 90% left');
});

test('missing metrics stay unavailable, while zero, exhausted, and fractional allowances remain distinct', () => {
  expect(usageCard(limits(0)).content).toContain('100% left');
  expect(usageCard(limits(100)).content).toContain('0% left');
  expect(usageCard(limits(120)).content).toContain('0% left');
  expect(usageCard(limits(-1)).content).toContain('100% left');
  expect(usageCard(limits(99.99)).content).toContain('<0.1% left');
  expect(usageCard(limits(0.01)).content).toContain('99.9% left');
  for (const invalid of [null, undefined, NaN, Infinity]) {
    const rendered = usageCard(limits(invalid as any));
    expect(rendered.content).toContain('Usage unavailable');
    expect(rendered.content).not.toContain('% left');
    expect(rendered.content).not.toMatch(/[🟦🟨🟥⬛]/u);
  }
  expect(usageCard({ rateLimits: { primary: null, secondary: null } }).content).toContain('Allowance unavailable');
  expect(usageCard(null).content).toContain('Account allowance unavailable');
});

test('backend blocking overrides apparently available quota and past reset times do not refill the bar', () => {
  const blocked = usageCard({ ...limits(35), ordinaryUsageAllowed: false });
  expect(blocked.content).toContain('currently blocked');
  expect(blocked.card?.tone).toBe('danger');
  expect(blocked.content).toContain('65% left');
  const expired = usageCard({ rateLimits: { primary: { ...window(100), resetsAt: now - 10 } } }, undefined, undefined, now);
  expect(expired.content).toContain('0% left');
  expect(expired.content).toContain('Reset time passed');
  expect(expired.card?.tone).toBe('danger');
  expect(expired.content).toContain('\n⬛⬛⬛⬛⬛⬛⬛⬛⬛⬛\n');
  expect(usageCard(limits(85)).card?.tone).toBe('warning');
  expect(usageCard(limits(85)).content).toContain('\n🟨⬛⬛⬛⬛⬛⬛⬛⬛⬛\n');
  expect(usageCard(limits(90)).content).toContain('\n🟥⬛⬛⬛⬛⬛⬛⬛⬛⬛\n');
  const spendLimit = usageCard({ ordinaryUsageAllowed: true, rateLimits: { primary: window(0), spendControlReached: true } });
  expect(spendLimit.content).toContain('An account limit has been reached');
  expect(spendLimit.content).not.toContain('Included usage is currently blocked');
});

test('multiple quota buckets prefer the authoritative map and fit within a compact Components V2 card', () => {
  const data: AccountRateLimits = {
    rateLimits: { limitId: 'codex', primary: window(90) },
    rateLimitsByLimitId: {
      codex: { primary: window(35), secondary: window(10, 300) },
      review: { limitName: 'Code review', primary: window(50) },
    },
  };
  const rendered = usageCard(data);
  expect(rendered.content).toContain('codex · Weekly allowance · 65% left');
  expect(rendered.content).toContain('Code review · Weekly allowance · 50% left');
  expect(rendered.content).not.toContain('10% left');
  expect(rendered.content.match(/Weekly allowance/g)).toHaveLength(2);
  data.rateLimitsByLimitId = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`bucket-${i}`, {
    limitName: '**'.repeat(100), primary: window(20, 300), secondary: window(40),
  }]));
  const many = usageCard(data);
  expect(many.content).toContain('additional limit groups not shown');
  expect(many.file).toBeUndefined();
  expect(JSON.stringify(discordPayload(many).components.map(c => c.toJSON()))).not.toContain('NaN');
  expect(many.content.length).toBeLessThan(3400);
});

test('session tokens are independently timestamped and do not claim to be remaining allowance', () => {
  const snapshot = tokenUsageSnapshot({ total: { totalTokens: 123456, inputTokens: 120000, outputTokens: 3456 } }, now);
  const rendered = usageCard(limits(35), snapshot);
  expect(rendered.content).toContain('Session tokens · 123,456 used');
  expect(rendered.content).toContain(`120,000 in · 3,456 out · Last reported <t:${now}:R>`);
  expect(usageCard(limits(35), null).content).toContain('after the next usage update');
  for (const invalid of [null, {}, { total: {} }, { total: { totalTokens: null, inputTokens: 1, outputTokens: 1 } }]) {
    expect(tokenUsageSnapshot(invalid)).toBeNull();
  }
  expect(tokenUsageSnapshot({ total: { totalTokens: 0, inputTokens: 0, outputTokens: 0 } }, now)?.total.totalTokens).toBe(0);
});

test('metered map keys identify buckets and a legacy fallback cannot add a phantom limit', () => {
  const data: AccountRateLimits = {
    rateLimitsByLimitId: {
      review: { limitId: null, primary: window(20) },
      images: { limitId: null, primary: window(40) },
    },
    rateLimits: { limitId: null, primary: window(100), spendControlReached: true },
  };
  const delivery = usageCard(data);
  expect(delivery.content).toContain('review · Weekly allowance · 80% left');
  expect(delivery.content).toContain('images · Weekly allowance · 60% left');
  expect(delivery.content).not.toContain('An account limit has been reached');
  expect(delivery.card?.tone).toBe('info');
  expect(usageCard({ ...data, rateLimitsByLimitId: null }).card?.tone).toBe('danger');
});
