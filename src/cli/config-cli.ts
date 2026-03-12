import type { Command } from "commander";
import JSON5 from "json5";
import {
  listConfigBackups,
  createConfigBackup,
  restoreConfigBackup,
  getBackupStats,
} from "../config/config-backup-restore.js";
import { OLLAMA_DEFAULT_BASE_URL } from "../agents/ollama-defaults.js";
import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { formatConfigIssueLines, normalizeConfigIssues } from "../config/issue-format.js";
import { CONFIG_PATH } from "../config/paths.js";
import { isBlockedObjectKey } from "../config/prototype-keys.js";
import { redactConfigObject } from "../config/redact-snapshot.js";
import { danger, info, success } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";

type PathSegment = string;
type ConfigSetParseOpts = {
  strictJson?: boolean;
};

const OLLAMA_API_KEY_PATH: PathSegment[] = ["models", "providers", "ollama", "apiKey"];
const OLLAMA_PROVIDER_PATH: PathSegment[] = ["models", "providers", "ollama"];

function isIndexSegment(raw: string): boolean {
  return /^[0-9]+$/.test(raw);
}

function parsePath(raw: string): PathSegment[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  const parts: string[] = [];
  let current = "";
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === "\\") {
      const next = trimmed[i + 1];
      if (next) {
        current += next;
      }
      i += 2;
      continue;
    }
    if (ch === ".") {
      if (current) {
        parts.push(current);
      }
      current = "";
      i += 1;
      continue;
    }
    if (ch === "[") {
      if (current) {
        parts.push(current);
      }
      current = "";
      const close = trimmed.indexOf("]", i);
      if (close === -1) {
        throw new Error(`Invalid path (missing "]"): ${raw}`);
      }
      const inside = trimmed.slice(i + 1, close).trim();
      if (!inside) {
        throw new Error(`Invalid path (empty "[]"): ${raw}`);
      }
      parts.push(inside);
      i = close + 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current) {
    parts.push(current);
  }
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseValue(raw: string, opts: ConfigSetParseOpts): unknown {
  const trimmed = raw.trim();
  if (opts.strictJson) {
    try {
      return JSON5.parse(trimmed);
    } catch (err) {
      throw new Error(`Failed to parse JSON5 value: ${String(err)}`, { cause: err });
    }
  }

  try {
    return JSON5.parse(trimmed);
  } catch {
    return raw;
  }
}

function hasOwnPathKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function formatDoctorHint(message: string): string {
  return `Run \`${formatCliCommand("openclaw doctor")}\` ${message}`;
}

function validatePathSegments(path: PathSegment[]): void {
  for (const segment of path) {
    if (!isIndexSegment(segment) && isBlockedObjectKey(segment)) {
      throw new Error(`Invalid path segment: ${segment}`);
    }
  }
}

function getAtPath(root: unknown, path: PathSegment[]): { found: boolean; value?: unknown } {
  let current: unknown = root;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return { found: false };
    }
    if (Array.isArray(current)) {
      if (!isIndexSegment(segment)) {
        return { found: false };
      }
      const index = Number.parseInt(segment, 10);
      if (!Number.isFinite(index) || index < 0 || index >= current.length) {
        return { found: false };
      }
      current = current[index];
      continue;
    }
    const record = current as Record<string, unknown>;
    if (!hasOwnPathKey(record, segment)) {
      return { found: false };
    }
    current = record[segment];
  }
  return { found: true, value: current };
}

function setAtPath(root: Record<string, unknown>, path: PathSegment[], value: unknown): void {
  let current: unknown = root;