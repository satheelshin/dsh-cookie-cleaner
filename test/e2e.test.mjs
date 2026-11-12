// 端到端：真的把守护进程拉起来，看它能不能自己发现「DSH 没了」并完成备份+清理。
// 只碰临时目录。用 SingletonLock 给守护一个确定信号，不依赖本机是否真的跑着 DSH。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DAEMON = fileURLToPath(new URL('../daemon/monitor.py', import.meta.url))
const PYTHON = process.env.DSH_COOKIE_PYTHON || (fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3')
const SQLITE = fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3'

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cookie-e2e-'))
}

function seed(db, count) {
  fs.mkdirSync(path.dirname(db), { recursive: true })
  const sql = ['CREATE TABLE cookies (host_key TEXT, name TEXT, expires_utc INTEGER);']
  for (let i = 0; i < count; i++) sql.push(`INSERT INTO cookies VALUES ('localhost','dsh-auth-${i}',0);`)
  const r = spawnSync(SQLITE, [db, sql.join('\n')], { encoding: 'utf8' })
  assert.equal(r.status, 0, `造库失败：${r.stderr}`)
}

function paths(root) {
  return {
    db: path.join(root, 'app', 'Cookies'),
    singleton: path.join(root, 'app', 'SingletonLock'),
    backups: path.join(root, 'backups'),
    log: path.join(root, 'monitor.log'),
  }
}

// 造一个「确定已经死了」的 PID：跑一个立刻退出的 node，拿它的 pid。
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid
}

// Electron 的 SingletonLock 是 `hostname-pid` 的符号链接。给它一个确定的 PID，
// 守护就不必依赖 ps 也能判断 DSH 在不在。
function linkLock(singleton, pid) {
  fs.mkdirSync(path.dirname(singleton), { recursive: true })
  fs.symlinkSync(`e2ehost-${pid}`, singleton)
}

function daemonLog(p) {
  try {
    return fs.readFileSync(p.log, 'utf8')
  } catch {
    return '(守护没写日志——可能根本没启动)'
  }
}

// 超时的时候把守护日志一起抛出来，不然 CI 上只看得到「等待超时」。
async function waitOrExplain(fn, p, timeoutMs) {
  try {
    await waitFor(fn, timeoutMs)
  } catch (e) {
    throw new Error(`${e.message}\n--- 守护日志 ---\n${daemonLog(p)}`)
  }
}

function waitFor(fn, timeoutMs = 10000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error('等待超时'))
      setTimeout(tick, 50)
    }
    tick()
  })
}

function runDaemon(p, extra = []) {
  return spawn(PYTHON, [
    DAEMON,
    '--db', p.db,
    '--singleton', p.singleton,
    '--backup-dir', p.backups,
    '--log', p.log,
    '--app-mark', '__dsh_e2e_never_matches__',
    ...extra,
  ], { stdio: 'ignore' })
}

test('守护循环：发现 DSH 不在 → 备份后删除 cookie 库', async () => {
  const root = home()
  const p = paths(root)
  seed(p.db, 4)
  linkLock(p.singleton, deadPid())

  const child = runDaemon(p, ['--grace-seconds', '0.3', '--poll-seconds', '0.1'])
  try {
    await waitOrExplain(() => !fs.existsSync(p.db), p)
    const saved = fs.readdirSync(p.backups).filter((n) => n.startsWith('cookies-'))
    assert.equal(saved.length, 1, '应当留下 1 份备份')
    assert.ok(fs.existsSync(path.join(p.backups, saved[0], 'Cookies')), '备份里应有 Cookies')
    assert.match(fs.readFileSync(p.log, 'utf8'), /已清理 4 条/)
  } finally {
    child.kill('SIGTERM')
  }
})

test('守护循环：库是空的就不留备份', async () => {
  const root = home()
  const p = paths(root)
  seed(p.db, 0)
  linkLock(p.singleton, deadPid())

  const child = runDaemon(p, ['--grace-seconds', '0.2', '--poll-seconds', '0.1'])
  try {
    await waitOrExplain(() => !fs.existsSync(p.db), p)
    assert.deepEqual(fs.readdirSync(p.backups), [], '0 条时不该产生备份')
    assert.match(fs.readFileSync(p.log, 'utf8'), /0 条 cookie/)
  } finally {
    child.kill('SIGTERM')
  }
})

test('--once：lock 指向活进程时拒绝清理，库原样保留', () => {
  const root = home()
  const p = paths(root)
  seed(p.db, 2)
  linkLock(p.singleton, process.pid) // 自己就是那个「还在跑的 DSH」

  const r = spawnSync(PYTHON, [
    DAEMON, '--once',
    '--db', p.db,
    '--singleton', p.singleton,
    '--backup-dir', p.backups,
    '--log', p.log,
    '--app-mark', '__dsh_e2e_never_matches__',
  ], { encoding: 'utf8' })

  assert.equal(r.status, 2, `应当以 2 退出，实际 ${r.status}：${r.stderr}`)
  assert.ok(fs.existsSync(p.db), 'DSH 在跑时不许动库')
})

test('--once：lock 指向死进程时立即清理并返回 0', () => {
  const root = home()
  const p = paths(root)
  seed(p.db, 3)
  linkLock(p.singleton, deadPid())

  const r = spawnSync(PYTHON, [
    DAEMON, '--once',
    '--db', p.db,
    '--singleton', p.singleton,
    '--backup-dir', p.backups,
    '--log', p.log,
    '--app-mark', '__dsh_e2e_never_matches__',
  ], { encoding: 'utf8' })

  assert.equal(r.status, 0, `应当以 0 退出，实际 ${r.status}：${r.stderr}`)
  assert.equal(fs.existsSync(p.db), false)
  assert.equal(fs.readdirSync(p.backups).length, 1)
})
