// 用假 HOME + 假 launchctl 演练安装/诊断/卸载，绝不碰真实环境。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  defaultContext,
  plistXml,
  cookieStats,
  cookieVerdict,
  status,
  install,
  uninstall,
  formatStatus,
  LABEL,
} from '../lib/manager.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cookie-test-'))
}

// 假 launchctl：print 看标记文件，bootstrap 建标记，bootout 删标记。
// bootout 后还会「赖」几轮 print 才真消失，用来模拟真实 launchd 的异步退出。
function fakeLaunchctl(dir, lingerRounds = 2) {
  const bin = path.join(dir, 'launchctl')
  const marker = path.join(dir, 'loaded.marker')
  const linger = path.join(dir, 'linger.count')
  const calls = path.join(dir, 'calls.log')
  fs.writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> "${calls}"
case "$1" in
  print)
    if [ -f "${linger}" ]; then
      n=$(cat "${linger}")
      if [ "$n" -gt 0 ]; then echo $((n - 1)) > "${linger}"; echo "state = running"; exit 0; fi
      rm -f "${linger}"
    fi
    [ -f "${marker}" ] && echo "state = running" && exit 0
    echo "Could not find service" >&2
    exit 113 ;;
  bootstrap) : > "${marker}"; exit 0 ;;
  bootout) rm -f "${marker}"; echo ${lingerRounds} > "${linger}"; exit 0 ;;
  load) : > "${marker}"; exit 0 ;;
esac
exit 0
`,
  )
  fs.chmodSync(bin, 0o755)
  return { bin, marker, linger, calls }
}

function ctxFor(home, launchctlBin) {
  const ctx = defaultContext({ HOME: home })
  ctx.platform = 'darwin'
  ctx.uid = 501
  ctx.bootoutTimeoutMs = 600
  if (launchctlBin) ctx.launchctl = launchctlBin
  return ctx
}

function seedCookies(home, counts) {
  const dir = path.join(home, 'Library', 'Application Support', '@deepseek-ai', 'dsh-desktop')
  fs.mkdirSync(dir, { recursive: true })
  const db = path.join(dir, 'Cookies')
  execFileSync('/usr/bin/sqlite3', [db, 'CREATE TABLE cookies (host_key TEXT, name TEXT, expires_utc INTEGER);'])
  for (let i = 0; i < counts; i++) {
    execFileSync('/usr/bin/sqlite3', [db, `INSERT INTO cookies VALUES ('localhost','dsh-auth-${i}',0);`])
  }
  return db
}

test('defaultContext 的路径都落在 HOME 下', () => {
  const home = tmpHome()
  const ctx = defaultContext({ HOME: home })
  assert.equal(ctx.stateDir, path.join(home, '.dsh', 'dsh-cookie-cleaner'))
  assert.equal(ctx.plistPath, path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`))
  assert.ok(ctx.cookieDb.endsWith(path.join('dsh-desktop', 'Cookies')))
})

test('plistXml 带全参数，路径含空格也不破 XML', () => {
  const home = path.join(tmpHome(), 'with space')
  fs.mkdirSync(home, { recursive: true })
  const xml = plistXml(ctxFor(home), { keepBackups: 5, graceSeconds: 9, pollSeconds: 4 })
  assert.match(xml, new RegExp(`<string>${LABEL}</string>`))
  assert.match(xml, /--keep-backups<\/string>\s*<string>5<\/string>/)
  assert.match(xml, /--grace-seconds<\/string>\s*<string>9<\/string>/)
  assert.match(xml, /with space/)
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/)
})

test('cookieStats 用只读 URI 数条数', async () => {
  const home = tmpHome()
  const db = seedCookies(home, 7)
  const stats = await cookieStats(ctxFor(home))
  assert.equal(stats.exists, true)
  assert.equal(stats.count, 7)
  assert.ok(stats.size > 0)
  assert.ok(db.endsWith('Cookies'))
})

test('cookieStats 库不存在时不报错', async () => {
  const stats = await cookieStats(ctxFor(tmpHome()))
  assert.equal(stats.exists, false)
  assert.equal(stats.count, null)
  assert.match(stats.note, /不存在/)
})

test('cookieVerdict 阈值', () => {
  assert.equal(cookieVerdict(0), 'ok')
  assert.equal(cookieVerdict(49), 'ok')
  assert.equal(cookieVerdict(50), 'warn')
  assert.equal(cookieVerdict(70), 'danger')
  assert.equal(cookieVerdict(null), 'unknown')
})

test('install 写脚本和 plist，并通过 bootstrap 加载', async () => {
  const home = tmpHome()
  const fake = fakeLaunchctl(tmpHome())
  const ctx = ctxFor(home, fake.bin)
  const r = await install(ctx, { keepBackups: 4 })
  assert.equal(r.ok, true)
  assert.equal(r.replaced, false)
  assert.equal(r.keepBackups, 4)
  assert.equal(fs.existsSync(ctx.scriptPath), true)
  assert.equal(fs.existsSync(ctx.plistPath), true)
  assert.ok(fs.statSync(ctx.scriptPath).mode & 0o111, '守护脚本应当可执行')
  const calls = fs.readFileSync(fake.calls, 'utf8')
  assert.match(calls, /bootstrap gui\/501/)
  assert.match(fs.readFileSync(ctx.plistPath, 'utf8'), /--db<\/string>/)
})

test('重复 install 会先 bootout 再 bootstrap（修复路径）', async () => {
  const home = tmpHome()
  const fake = fakeLaunchctl(tmpHome())
  const ctx = ctxFor(home, fake.bin)
  await install(ctx)
  fs.writeFileSync(fake.calls, '')
  const r = await install(ctx)
  assert.equal(r.ok, true)
  assert.equal(r.replaced, true)
  const calls = fs.readFileSync(fake.calls, 'utf8')
  assert.match(calls, /bootout gui\/501\/com\.deepseek\.dsh-cookie-cleaner/)
})

test('重装要等旧服务真消失，不能把「旧的还挂着」当成功', async () => {
  const home = tmpHome()
  const fake = fakeLaunchctl(tmpHome(), 2)
  const ctx = ctxFor(home, fake.bin)
  await install(ctx)
  fs.writeFileSync(fake.calls, '')
  const r = await install(ctx)
  assert.equal(r.ok, true)
  assert.equal(r.replaced, true)
  const calls = fs.readFileSync(fake.calls, 'utf8').trim().split('\n')
  const bootoutAt = calls.findIndex((l) => l.startsWith('bootout'))
  const bootstrapAt = calls.findIndex((l) => l.startsWith('bootstrap'))
  assert.ok(bootoutAt > -1 && bootstrapAt > bootoutAt, '必须先 bootout、等它消失，再 bootstrap')
  const printsBetween = calls.slice(bootoutAt, bootstrapAt).filter((l) => l.startsWith('print')).length
  assert.ok(printsBetween >= 3, `中间应当轮询过 print，实际 ${printsBetween} 次`)
})

test('bootout 一直不消失时直接报错，不假装装好', async () => {
  const home = tmpHome()
  const fake = fakeLaunchctl(tmpHome(), 999)
  const ctx = ctxFor(home, fake.bin)
  await install(ctx)
  const r = await install(ctx)
  assert.equal(r.ok, false)
  assert.match(r.error, /bootout 超时/)
})

test('bootstrap 失败时回退 load -w，两条都失败就报错', async () => {
  const home = tmpHome()
  const bin = path.join(tmpHome(), 'launchctl')
  fs.writeFileSync(bin, '#!/bin/sh\nexit 1\n')
  fs.chmodSync(bin, 0o755)
  const r = await install(ctxFor(home, bin))
  assert.equal(r.ok, false)
  assert.match(r.error, /launchctl/)
})

test('uninstall 保留备份；purge 才删状态目录', async () => {
  const home = tmpHome()
  const fake = fakeLaunchctl(tmpHome())
  const ctx = ctxFor(home, fake.bin)
  await install(ctx)
  fs.mkdirSync(ctx.backupDir, { recursive: true })
  fs.writeFileSync(path.join(ctx.backupDir, 'cookies-20260101-000000'), 'x')

  const keep = await uninstall(ctx)
  assert.equal(keep.ok, true)
  assert.equal(fs.existsSync(ctx.plistPath), false)
  assert.equal(fs.existsSync(ctx.stateDir), true)

  const purged = await uninstall(ctx, { purge: true })
  assert.equal(purged.ok, true)
  assert.equal(fs.existsSync(ctx.stateDir), false)
})

test('uninstall 拒绝删除非 ~/.dsh/dsh-cookie-cleaner 的目录', async () => {
  const home = tmpHome()
  const ctx = ctxFor(home, fakeLaunchctl(tmpHome()).bin)
  ctx.stateDir = path.join(home, 'some-other-dir')
  fs.mkdirSync(ctx.stateDir, { recursive: true })
  const r = await uninstall(ctx, { purge: true })
  assert.equal(r.ok, false)
  assert.match(r.error, /拒绝删除/)
  assert.equal(fs.existsSync(ctx.stateDir), true)
})

test('status 汇总守护状态、条数、备份与日志', async () => {
  const home = tmpHome()
  const fake = fakeLaunchctl(tmpHome())
  const ctx = ctxFor(home, fake.bin)
  await install(ctx)
  seedCookies(home, 3)
  fs.writeFileSync(ctx.logPath, '[2026-01-01 00:00:00] 已清理 3 条\n')
  const s = await status(ctx)
  assert.equal(s.launch.loaded, true)
  assert.equal(s.cookies.count, 3)
  assert.equal(s.log.length, 1)
  const text = formatStatus(s)
  assert.match(text, /已加载/)
  assert.match(text, /cookie 条数：3/)
})

test('python 不存在时 install 直接拒绝，不写 plist', async () => {
  const home = tmpHome()
  const ctx = ctxFor(home, fakeLaunchctl(tmpHome()).bin)
  ctx.python = path.join(home, 'no-such-python')
  const r = await install(ctx, {})
  assert.equal(r.ok, false)
  assert.match(r.error, /python3/)
  assert.equal(fs.existsSync(ctx.plistPath), false, '装不上就不该留下 plist')
})

test('status 报告 python3 是否可执行', async () => {
  const home = tmpHome()
  const ctx = ctxFor(home, fakeLaunchctl(tmpHome()).bin)
  ctx.python = path.join(home, 'no-such-python')
  const s = await status(ctx)
  assert.equal(s.python.ok, false)
})

test('status 在守护未加载时给出警告', async () => {
  const home = tmpHome()
  const ctx = ctxFor(home, fakeLaunchctl(tmpHome()).bin)
  const text = formatStatus(await status(ctx))
  assert.match(text, /未加载/)
})
