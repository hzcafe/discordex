import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface Config {
  guildId: string;
  channelId: string;
  allowedUserIds: string[];
  approverUserIds: string[];
  autoDiscover: boolean;
  projectRoots: string[];
  socketPath: string;
  stateDir: string;
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
  return { guildId: value.guildId, channelId: value.channelId, allowedUserIds: value.allowedUserIds,
    approverUserIds: value.approverUserIds, autoDiscover: value.autoDiscover ?? true,
    projectRoots: projectRoots.map((p: string) => resolve(p)), socketPath, stateDir };
}
