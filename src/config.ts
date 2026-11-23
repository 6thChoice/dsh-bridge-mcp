/**
 * Optional per-user config file (release contract: "Portability").
 *
 * `${XDG_CONFIG_HOME:-~/.config}/dsh-bridge/config.json`, if present:
 *
 *     { "url": "http://127.0.0.1:49904/?token=…", "host": "http://127.0.0.1:49904",
 *       "dshHome": "~/.dsh" }
 *
 * The file sits in the host ladder between the environment and platform
 * discovery. It is optional, but it is never silently ignored: invalid JSON,
 * unknown keys, and non-string values all raise a `ConfigError` that names the
 * file and the problem. `url` wins over `host` when both are present.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ConfigError } from './errors.js';

/** The only keys the file may contain. */
export const CONFIG_KEYS = ['url', 'host', 'dshHome'] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export interface BridgeConfig {
  /** DSH launch URL, possibly with `?token=`. Contributes its origin to host resolution. */
  url?: string;
  /** DSH Web origin, e.g. `http://127.0.0.1:49904`. */
  host?: string;
  /** DSH home for credentials and the send index; `~` is expanded. */
  dshHome?: string;
}

export interface LoadedConfig {
  /** The path that was consulted, whether or not it exists. */
  path: string;
  /** `undefined` when the file does not exist. */
  config: BridgeConfig | undefined;
}

export interface ConfigPathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

/** Resolve the config path; a relative `$XDG_CONFIG_HOME` is ignored per the XDG spec. */
export function configFilePath(options: ConfigPathOptions = {}): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg !== '' && isAbsolute(xdg) ? xdg : join(homeDir, '.config');
  return join(base, 'dsh-bridge', 'config.json');
}

/** Expand a leading `~` (alone, `~/…`, or `~\…`) against an explicit home directory. */
export function expandHome(input: string, homeDir: string = homedir()): string {
  if (input === '~') return homeDir;
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homeDir, input.slice(2));
  return input;
}

/**
 * Parse config file text. Exported for tests; `loadConfig` is the production entry.
 * Every failure names the file so the error is actionable without a stack trace.
 */
export function parseConfig(source: string, path: string): BridgeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ConfigError(
      `config file ${path} is not valid JSON: ${(error as Error).message}`,
      { cause: error },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `config file ${path} must contain a JSON object with optional keys ` +
        `${CONFIG_KEYS.join(', ')}`,
    );
  }

  const record = parsed as Record<string, unknown>;
  const allowed: readonly string[] = CONFIG_KEYS;
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ConfigError(
      `config file ${path} has unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')}; ` +
        `allowed keys: ${CONFIG_KEYS.join(', ')}`,
    );
  }

  const config: BridgeConfig = {};
  for (const key of CONFIG_KEYS) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConfigError(`config file ${path}: "${key}" must be a non-empty string`);
    }
    config[key] = value.trim();
  }
  return config;
}

export interface LoadConfigOptions extends ConfigPathOptions {
  /** Explicit path override; used by tests. */
  path?: string;
}

/** Read the optional config file. A missing file is not an error; a bad one is. */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const path = options.path ?? configFilePath(options);
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, config: undefined };
    throw new ConfigError(`cannot read config file ${path}: ${String(error)}`, { cause: error });
  }
  return { path, config: parseConfig(source, path) };
}

export interface DshHomeOptions {
  /** `--dsh-home`, already higher priority than `$DSH_HOME`. */
  flag?: string;
  env?: NodeJS.ProcessEnv;
  config?: BridgeConfig;
  homeDir?: string;
}

/**
 * DSH home ladder: `--dsh-home` → `$DSH_HOME` → config `dshHome` → `~/.dsh`.
 * `~` is expanded at every rung (the shell usually does it for flags, not for config).
 */
export function resolveDshHome(options: DshHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  if (options.flag !== undefined && options.flag !== '') return expandHome(options.flag, homeDir);
  const fromEnv = env.DSH_HOME;
  if (fromEnv !== undefined && fromEnv !== '') return expandHome(fromEnv, homeDir);
  const fromConfig = options.config?.dshHome;
  if (fromConfig !== undefined) return expandHome(fromConfig, homeDir);
  return join(homeDir, '.dsh');
}
