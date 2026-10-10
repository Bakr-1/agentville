import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuPercent, diskRoots, readHealth } from '../platform/health.mjs';

const times = (user, sys, idle) => ({ user, nice: 0, sys, idle, irq: 0 });
const cpus = (...t) => t.map(x => ({ model: 'x', speed: 1, times: x }));

test('CPU percent is the busy share of the time between two reads; the first read has nothing to compare', () => {
  const a = cpus(times(100, 100, 800), times(100, 100, 800));
  const b = cpus(times(200, 150, 850), times(150, 100, 950));
  assert.equal(cpuPercent(null, a), null);
  // core 1 busy 150 of 200, core 2 busy 50 of 200: 200 of 400 = 50%
  assert.equal(cpuPercent(a, b), 50);
  assert.equal(cpuPercent(a, a), null); // no time passed: not a number
  assert.equal(cpuPercent(a, cpus(times(1, 1, 1))), null); // a different core count: not comparable
});

test('disk roots are the drive letters on Windows and the root plus /Volumes on macOS', () => {
  const exists = p => ['C:\\', 'D:\\'].includes(p);
  assert.deepEqual(diskRoots('win32', { exists }), ['C:\\', 'D:\\']);
  assert.deepEqual(diskRoots('darwin', { list: () => ['Macintosh HD', 'Backup'] }), ['/', '/Volumes/Backup']);
  assert.deepEqual(diskRoots('darwin', { list: () => { throw new Error('nope'); } }), ['/']);
});

test('a read gives CPU, memory used and total, free space per disk, and uptime, from stand-ins', async () => {
  const os = { cpus: () => cpus(times(200, 150, 850)), totalmem: () => 32 * 2 ** 30, freemem: () => 8 * 2 ** 30, uptime: () => 90061 };
  const statfs = root => ({ C: { bsize: 4096, blocks: 250 * 2 ** 30 / 4096, bavail: 100 * 2 ** 30 / 4096 }, D: { bsize: 4096, blocks: 1000 * 2 ** 30 / 4096, bavail: 900 * 2 ** 30 / 4096 } })[root[0]];
  const first = await readHealth({ os, statfs, platform: 'win32', exists: p => ['C:\\', 'D:\\'].includes(p), prev: null });
  assert.equal(first.health.cpuPct, null);
  assert.equal(first.health.mem.usedMb, 24 * 1024);
  assert.equal(first.health.mem.totalMb, 32 * 1024);
  assert.deepEqual(first.health.disks, [{ root: 'C:\\', freeGb: 100, totalGb: 250 }, { root: 'D:\\', freeGb: 900, totalGb: 1000 }]);
  assert.equal(first.health.uptimeSec, 90061);
  const os2 = { ...os, cpus: () => cpus(times(300, 200, 900)) };
  assert.equal((await readHealth({ os: os2, statfs, platform: 'win32', exists: () => false, prev: first.cpus })).health.cpuPct, 75); // (100 + 50 busy) of 200
});

test('a disk that cannot be read is left out, and a read that fails entirely says so instead of inventing numbers', async () => {
  const os = { cpus: () => cpus(times(1, 1, 1)), totalmem: () => 2 ** 30, freemem: () => 2 ** 29, uptime: () => 5 };
  const statfs = root => { if (root === 'D:\\') throw new Error('not ready'); return { bsize: 1, blocks: 2 ** 30, bavail: 2 ** 29 }; };
  const r = await readHealth({ os, statfs, platform: 'win32', exists: () => true, prev: null, roots: ['C:\\', 'D:\\'] });
  assert.deepEqual(r.health.disks.map(d => d.root), ['C:\\']);
  const broken = await readHealth({ os: { ...os, totalmem: () => { throw new Error('x'); } }, statfs, platform: 'win32', prev: null, roots: [] });
  assert.equal(broken.health, null);
});

test('one real read on this machine returns plausible numbers', async () => {
  const r = await readHealth({ prev: null });
  assert.ok(r.health.mem.totalMb > 256 && r.health.mem.usedMb > 0 && r.health.mem.usedMb <= r.health.mem.totalMb);
  assert.ok(r.health.uptimeSec > 0);
  assert.ok(r.health.disks.length >= 1 && r.health.disks.every(d => d.totalGb > 0 && d.freeGb >= 0 && d.freeGb <= d.totalGb));
});

test('drives that are the same volume (network shares of one disk) show once; a drive that never answers is dropped after the timeout', async () => {
  const os = { cpus: () => cpus(times(1, 1, 1)), totalmem: () => 2 ** 30, freemem: () => 2 ** 29, uptime: () => 5 };
  const same = { bsize: 1, blocks: 100 * 2 ** 30, bavail: 40 * 2 ** 30 };
  const statfs = root => (root === 'Z:\\' ? new Promise(() => {}) : same);
  const r = await readHealth({ os, statfs, platform: 'win32', prev: null, roots: ['K:\\', 'S:\\', 'Z:\\'], diskTimeoutMs: 50 });
  assert.deepEqual(r.health.disks, [{ root: 'K:\\', freeGb: 40, totalGb: 100, also: ['S:\\'] }]);
});
