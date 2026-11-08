// Selectable Sandbox bank profiles (docs/contracts.md section 7b): PNC's HackUTD customers turned into Plaid custom users by
// data/pnc_profiles.py, plus the original family demo. Files live in data/plaid/profiles/ (<profile_id>.json + index.json),
// next to data/plaid/sandbox_user.json, so the production worker finds them through the same ../data/plaid:/data/plaid:ro mount:
//   PLAID_PROFILES_DIR, else <DATA_DIR>/../plaid/profiles   (DATA_DIR defaults to ../../data/seed)
// The index is served as is (no secrets in it) and cached until the file changes. A profile id is only ever turned into a path
// after it has been found in the index, so a request can never read an arbitrary file.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { PKG_ROOT } from '../config.js';
import { loadSandboxUserJson } from './custom_user.js';

export const DEFAULT_PROFILE_ID = 'family_demo';
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** One row of GET /plaid/sandbox_profiles. data/pnc_profiles.py adds a few extra fields (persona, window, ...); they pass through. */
export interface SandboxProfile {
  profile_id: string;
  display_name: string;
  summary: string;
  accounts: { name: string; type: string; subtype: string; mask: string; balance: number }[];
  txn_count: number;
  [extra: string]: unknown;
}

/** What the routes need from the profile files (swapped for a fake in the tests). */
export interface SandboxProfiles {
  /** The index, in display order. Empty when no profile files are installed. */
  list(): SandboxProfile[];
  has(id: string): boolean;
  /** The profile as the compact JSON string Plaid expects in override_password, or null when it cannot be read. */
  customUserJson(id: string): string | null;
}

export function profilesDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.PLAID_PROFILES_DIR ?? '').trim();
  if (explicit) return resolve(PKG_ROOT, explicit);
  return resolve(PKG_ROOT, (env.DATA_DIR ?? '').trim() || '../../data/seed', '..', 'plaid', 'profiles');
}

const isEntry = (v: unknown): v is SandboxProfile =>
  Boolean(v) && typeof v === 'object' && typeof (v as SandboxProfile).profile_id === 'string' && PROFILE_ID_RE.test((v as SandboxProfile).profile_id) && typeof (v as SandboxProfile).display_name === 'string' && Array.isArray((v as SandboxProfile).accounts);

/** Fallback when index.json is missing: the family demo alone, described from sandbox_user.json (so the picker is never empty). */
function familyOnly(env: NodeJS.ProcessEnv): SandboxProfile[] {
  const json = loadSandboxUserJson(env);
  if (!json) return [];
  const cfg = JSON.parse(json) as { override_accounts?: { type: string; subtype: string; starting_balance: number; meta?: { name?: string; mask?: string }; transactions?: unknown[] }[] };
  const accts = cfg.override_accounts ?? [];
  return [
    {
      profile_id: DEFAULT_PROFILE_ID,
      display_name: 'The demo family',
      summary: `${accts.length} accounts and about six months of transactions`,
      accounts: accts.map((a) => ({ name: a.meta?.name ?? a.subtype, type: a.type, subtype: a.subtype, mask: a.meta?.mask ?? '', balance: a.starting_balance })),
      txn_count: accts.reduce((n, a) => n + (a.transactions?.length ?? 0), 0),
    },
  ];
}

export function createSandboxProfiles(env: NodeJS.ProcessEnv = process.env): SandboxProfiles {
  let cached: { path: string; mtimeMs: number; size: number; entries: SandboxProfile[] } | null = null;

  const list = (): SandboxProfile[] => {
    const path = resolve(profilesDir(env), 'index.json');
    try {
      const st = statSync(path);
      if (cached && cached.path === path && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.entries;
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const entries = Array.isArray(parsed) ? parsed.filter(isEntry) : [];
      if (!entries.length) throw new Error('empty index');
      cached = { path, mtimeMs: st.mtimeMs, size: st.size, entries };
      return entries;
    } catch {
      cached = null;
      return familyOnly(env);
    }
  };

  return {
    list,
    has: (id) => id === DEFAULT_PROFILE_ID || (PROFILE_ID_RE.test(id) && list().some((p) => p.profile_id === id)),
    customUserJson(id) {
      if (id === DEFAULT_PROFILE_ID) return loadSandboxUserJson(env); // PLAID_SANDBOX_USER_FILE override, else data/plaid/sandbox_user.json
      if (!PROFILE_ID_RE.test(id) || !list().some((p) => p.profile_id === id)) return null;
      try {
        const parsed: unknown = JSON.parse(readFileSync(resolve(profilesDir(env), `${id}.json`), 'utf8'));
        return parsed && typeof parsed === 'object' && Array.isArray((parsed as { override_accounts?: unknown }).override_accounts) ? JSON.stringify(parsed) : null;
      } catch {
        return null;
      }
    },
  };
}

/** Account masks a custom-user config defines: how an existing item is recognised as "this profile" (see connect.ts). */
export function profileMasks(customUserJson: string): Set<string> {
  try {
    const cfg = JSON.parse(customUserJson) as { override_accounts?: { meta?: { mask?: unknown } }[] };
    return new Set((cfg.override_accounts ?? []).map((a) => String(a.meta?.mask ?? '')).filter(Boolean));
  } catch {
    return new Set();
  }
}
