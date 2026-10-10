import { existsSync, readdirSync } from 'node:fs';
import { statfs as statfsPromise } from 'node:fs/promises';
import * as nodeOs from 'node:os';
import { posix } from 'node:path';

// The machine's own health for the dashboard header: CPU, memory, free disk space per drive, uptime. Read-only, and
// the same numbers on both systems because they come from Node (os, fs.statfs), not from a per-system program. A
// value that cannot be read is null or left out, never made up.

const GB = 2 ** 30;
const MB = 2 ** 20;

/** The share of all cores that was busy between two reads of os.cpus(); null for the first read or when they cannot be compared. */
export function cpuPercent(prev, now) {
  if (!prev || prev.length === 0 || prev.length !== now.length) return null;
  let busy = 0, total = 0;
  for (let i = 0; i < now.length; i++) {
    const a = prev[i].times, b = now[i].times;
    const idle = b.idle - a.idle;
    const all = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq) + idle;
    busy += all - idle;
    total += all;
  }
  return total > 0 ? Math.round((busy / total) * 100) : null;
}

/** Where to ask for free space: each existing drive letter on Windows; the root and each mounted volume on macOS. */
export function diskRoots(platform = process.platform, { exists = existsSync, list = readdirSync } = {}) {
  if (platform === 'win32') {
    return [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => `${letter}:\\`).filter(root => exists(root));
  }
  let volumes = [];
  try { volumes = list('/Volumes'); } catch { /* no /Volumes: just the root */ }
  return ['/', ...volumes.map(v => posix.join('/Volumes', v)).filter(v => v !== '/Volumes/Macintosh HD')];
}

/**
 * One reading. `prev` is the cpus() array from the last reading (null the first time); the caller keeps the
 * returned `cpus` for the next. Returns { health, cpus }; health is null when memory or uptime could not be read.
 * Disks are asked in the background with a time limit each, so a network drive that is gone cannot stall the
 * collector, and drives that are the same volume (shares of one disk) show once, the others listed in `also`.
 */
export async function readHealth({ os = nodeOs, statfs = statfsPromise, platform = process.platform, exists = existsSync, prev = null, roots, diskTimeoutMs = 2000 } = {}) {
  let cpus;
  try { cpus = os.cpus(); } catch { cpus = []; }
  let mem, uptimeSec;
  try {
    const total = os.totalmem();
    mem = { usedMb: Math.round((total - os.freemem()) / MB), totalMb: Math.round(total / MB) };
    uptimeSec = Math.round(os.uptime());
  } catch {
    return { health: null, cpus };
  }
  const asked = await Promise.all((roots ?? diskRoots(platform, { exists })).map(async root => {
    let timer;
    try {
      const s = await Promise.race([Promise.resolve().then(() => statfs(root)), new Promise((_, no) => { timer = setTimeout(() => no(new Error('timed out')), diskTimeoutMs); })]);
      const totalGb = Math.round((s.blocks * s.bsize) / GB);
      return totalGb > 0 ? { root, freeGb: Math.round((s.bavail * s.bsize) / GB), totalGb } : null;
    } catch {
      return null; // a drive that is not ready (an empty card reader) or does not answer: left out
    } finally {
      clearTimeout(timer);
    }
  }));
  const disks = [];
  for (const d of asked) {
    if (!d) continue;
    const same = disks.find(x => x.totalGb === d.totalGb && x.freeGb === d.freeGb);
    if (same) (same.also ??= []).push(d.root);
    else disks.push(d);
  }
  return { health: { cpuPct: cpuPercent(prev, cpus), mem, disks, uptimeSec }, cpus };
}
