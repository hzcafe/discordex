import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface ArtifactConfig {
  enabled: boolean;
  roots: string[];
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  cacheBytes: number;
  retentionDays: number;
}
export const defaultArtifacts: ArtifactConfig = {
  enabled: true, roots: [], maxFiles: 4, maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024, cacheBytes: 128 * 1024 * 1024, retentionDays: 7,
};

export interface InboundConfig {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  cacheBytes: number;
  retentionDays: number;
  concurrency: number;
  maxCachedFiles: number;
}
export const defaultInbound: InboundConfig = {
  maxFiles: 4, maxFileBytes: 32 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
  cacheBytes: 512 * 1024 * 1024, retentionDays: 7, concurrency: 2, maxCachedFiles: 4096,
};

export interface Config {
  guildId: string;
  channelId: string;
  allowedUserIds: string[];
  approverUserIds: string[];
  autoDiscover: boolean;
  projectRoots: string[];
  socketPath: string;
  stateDir: string;
  artifacts?: ArtifactConfig;
  inbound?: InboundConfig;
}
export function defaultSocket(): string {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control/app-server-control.sock');
}
export async function readConfig(path = process.env.DISCORDEX_CONFIG || 'discordex.config.json'): Promise<Config> {
  const value = await Bun.file(path).json();
  const snowflake = (v: unknown) => typeof v === 'string' && /^\d{17,20}$/.test(v);
  for (const key of ['guildId', 'channelId']) {
    if (!snowflake(value[key])) throw new Error(`${key} must be a Discord ID string in ${path}`);
  }
  for (const key of ['allowedUserIds', 'approverUserIds']) {
    if (!Array.isArray(value[key]) || !value[key].length || !value[key].every(snowflake)) {
      throw new Error(`${key} must contain at least one Discord user ID`);
    }
  }
  if (!value.approverUserIds.every((id: string) => value.allowedUserIds.includes(id))) {
    throw new Error('Every approver must also appear in allowedUserIds');
  }
  const projectRoots = value.projectRoots ?? [];
  if (!Array.isArray(projectRoots) || !projectRoots.every((p: unknown) => typeof p === 'string' && isAbsolute(p))) {
    throw new Error('projectRoots must be an array of absolute paths (empty means all projects)');
  }
  if (value.autoDiscover !== undefined && typeof value.autoDiscover !== 'boolean') throw new Error('autoDiscover must be a boolean');
  const socketPath = value.socketPath ?? defaultSocket();
  const stateDir = value.stateDir ?? join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'discordex');
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) throw new Error('socketPath must be absolute');
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) throw new Error('stateDir must be absolute');
  const supplied = value.artifacts ?? {};
  if (typeof supplied !== 'object' || Array.isArray(supplied)) throw new Error('artifacts must be an object');
  const artifacts: ArtifactConfig = { ...defaultArtifacts, ...supplied };
  if (typeof artifacts.enabled !== 'boolean') throw new Error('artifacts.enabled must be a boolean');
  if (!Array.isArray(artifacts.roots) || !artifacts.roots.every((p: unknown) => typeof p === 'string' && isAbsolute(p))) {
    throw new Error('artifacts.roots must contain absolute paths');
  }
  const limits = { maxFiles: 8, maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024,
    cacheBytes: 1024 * 1024 * 1024, retentionDays: 365 };
  for (const [key, max] of Object.entries(limits)) {
    const v = artifacts[key as keyof typeof limits];
    if (!Number.isSafeInteger(v) || v < 1 || v > max) throw new Error(`artifacts.${key} must be a whole number from 1 to ${max}`);
  }
  if (artifacts.maxFileBytes > artifacts.maxTotalBytes || artifacts.maxTotalBytes > artifacts.cacheBytes) {
    throw new Error('Artifact limits must satisfy maxFileBytes <= maxTotalBytes <= cacheBytes');
  }
  const suppliedInbound = value.inbound ?? {};
  if (typeof suppliedInbound !== 'object' || Array.isArray(suppliedInbound)) throw new Error('inbound must be an object');
  const inbound: InboundConfig = { ...defaultInbound, ...suppliedInbound };
  const inboundMaxima = { maxFiles: 8, maxFileBytes: 128 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024,
    cacheBytes: 4 * 1024 * 1024 * 1024, retentionDays: 365, concurrency: 8, maxCachedFiles: 65536 };
  for (const [key, max] of Object.entries(inboundMaxima)) {
    const v = inbound[key as keyof InboundConfig];
    if (!Number.isSafeInteger(v) || v < 1 || v > max) throw new Error(`inbound.${key} must be a whole number from 1 to ${max}`);
  }
  if (inbound.maxFileBytes > inbound.maxTotalBytes || inbound.maxTotalBytes > inbound.cacheBytes) {
    throw new Error('Inbound limits must satisfy maxFileBytes <= maxTotalBytes <= cacheBytes');
  }
  return { guildId: value.guildId, channelId: value.channelId, allowedUserIds: value.allowedUserIds,
    approverUserIds: value.approverUserIds, autoDiscover: value.autoDiscover ?? true,
    projectRoots: projectRoots.map((p: string) => resolve(p)), socketPath, stateDir, artifacts, inbound };
}
