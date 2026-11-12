// 安装 / 诊断 / 卸载 DSH cookie 常驻清理器。
// 只用 Node 标准库，不依赖 Cordis，方便脱离 DSH 直接跑测试。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const LABEL = 'com.deepseek.dsh-cookie-cleaner'
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DAEMON_SRC = path.join(PACKAGE_ROOT, 'daemon', 'monitor.py')

export const DEFAULTS = { keepBackups: 3, graceSeconds: 5, pollSeconds: 3 }

// cookie 条数到多少算危险：72 条左右请求头就过 16KB，触发 431。
export const WARN_COOKIES = 50
export const DANGER_COOKIES = 70

const APP_DIR = path.join('Library', 'Application Support', '@deepseek-ai', 'dsh-desktop')

function realRunner() {
  return (bin, args) =>
    new Promise((resolve) => {
      execFile(bin, args, { timeout: 20000, encoding: 'utf8' }, (err, stdout, stderr) => {
        let code = 0
        if (err) code = typeof err.code === 'number' ? err.code : 1
        resolve({
          code,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : (err ? String(err.message || err) : ''),
        })
      })
    })
}

// 所有路径都从 ctx 走，测试时换一个 HOME 就能整包演练，不碰真实环境。
export function defaultContext(env = process.env, run = realRunner()) {
  const home = env.HOME || os.homedir()
  const stateDir = path.join(home, '.dsh', 'dsh-cookie-cleaner')
  return {
    home,
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : 501,
    label: LABEL,
    stateDir,
    scriptPath: path.join(stateDir, 'monitor.py'),
    logPath: path.join(stateDir, 'monitor.log'),
    backupDir: path.join(stateDir, 'backups'),
    plistPath: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    appDir: path.join(home, APP_DIR),
    cookieDb: path.join(home, APP_DIR, 'Cookies'),
    singleton: path.join(home, APP_DIR, 'SingletonLock'),
    python: env.DSH_COOKIE_PYTHON || '/usr/bin/python3',
    sqlite: '/usr/bin/sqlite3',
    launchctl: '/bin/launchctl',
    run,
  }
}

export function userLang(env = process.env) {
  return /^zh/i.test(String(env.LANG || env.LC_ALL || '')) || process.env.DSH_LANG === 'zh' ? 'zh' : 'en'
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.round(n)
  if (i < min || i > max) return fallback
  return i
}

function xmlEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fileUri(p) {
  return 'file:' + p.split(path.sep).map(encodeURIComponent).join('/') + '?immutable=1'
}

function isOurStateDir(dir) {
  return path.basename(dir) === 'dsh-cookie-cleaner' && path.basename(path.dirname(dir)) === '.dsh'
}

export function isExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function plistXml(ctx, opts = {}) {
  const keep = clampInt(opts.keepBackups, DEFAULTS.keepBackups, 1, 20)
  const grace = clampInt(opts.graceSeconds, DEFAULTS.graceSeconds, 1, 600)
  const poll = clampInt(opts.pollSeconds, DEFAULTS.pollSeconds, 1, 60)
  const args = [
    ctx.python,
    '-B',
    ctx.scriptPath,
    '--db', ctx.cookieDb,
    '--singleton', ctx.singleton,
    '--backup-dir', ctx.backupDir,
    '--log', ctx.logPath,
    '--keep-backups', String(keep),
    '--grace-seconds', String(grace),
    '--poll-seconds', String(poll),
  ]
  const lines = args.map((a) => `\t\t<string>${xmlEscape(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${xmlEscape(LABEL)}</string>
\t<key>ProgramArguments</key>
\t<array>
${lines}
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>ThrottleInterval</key>
\t<integer>10</integer>
\t<key>ProcessType</key>
\t<string>Background</string>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(path.join(ctx.stateDir, 'launchd.out.log'))}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(path.join(ctx.stateDir, 'launchd.err.log'))}</string>
</dict>
</plist>
`
}

export async function launchState(ctx) {
  const r = await ctx.run(ctx.launchctl, ['print', `gui/${ctx.uid}/${ctx.label}`])
  const loaded = r.code === 0
  const text = `${r.stdout}\n${r.stderr}`
  const m = text.match(/\bstate = (\w+)/)
  return {
    loaded,
    state: loaded && m ? m[1] : (loaded ? 'unknown' : 'not-loaded'),
    detail: loaded ? '' : (r.stderr || r.stdout || '').trim().split('\n')[0] || '',
  }
}

export async function cookieStats(ctx) {
  const out = { path: ctx.cookieDb, exists: false, size: null, mtime: null, count: null, note: '' }
  try {
    const st = fs.statSync(ctx.cookieDb)
    out.exists = true
    out.size = st.size
    out.mtime = st.mtime.toISOString()
  } catch {
    out.note = 'cookie 库当前不存在（启动时会重新签发一条）'
    return out
  }
  const r = await ctx.run(ctx.sqlite, [fileUri(ctx.cookieDb), 'select count(*) from cookies;'])
  if (r.code !== 0) {
    out.note = `只读探测失败：${(r.stderr || r.stdout || '未知错误').trim().split('\n')[0]}`
    return out
  }
  const n = Number.parseInt(String(r.stdout).trim(), 10)
  if (Number.isFinite(n)) out.count = n
  else out.note = '只读探测返回了无法解析的结果'
  return out
}

export function logTail(ctx, lines = 12) {
  let raw = ''
  try {
    raw = fs.readFileSync(ctx.logPath, 'utf8')
  } catch {
    return []
  }
  return raw.split('\n').filter(Boolean).slice(-Math.max(1, lines))
}

export function backupList(ctx) {
  let names = []
  try {
    names = fs.readdirSync(ctx.backupDir).filter((n) => n.startsWith('cookies-')).sort().reverse()
  } catch {
    return []
  }
  return names.map((name) => {
    const dir = path.join(ctx.backupDir, name)
    let bytes = 0
    try {
      for (const f of fs.readdirSync(dir)) {
        try {
          bytes += fs.statSync(path.join(dir, f)).size
        } catch {}
      }
    } catch {}
    return { name, dir, bytes }
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(fn, timeoutMs, intervalMs = 200) {
  const start = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - start >= timeoutMs) return false
    await sleep(intervalMs)
  }
}

export async function status(ctx) {
  const [launch, cookies] = await Promise.all([launchState(ctx), cookieStats(ctx)])
  return {
    platform: ctx.platform,
    supported: ctx.platform === 'darwin',
    python: { path: ctx.python, ok: isExecutable(ctx.python) },
    launch,
    cookies,
    backups: backupList(ctx),
    log: logTail(ctx, 8),
    paths: { stateDir: ctx.stateDir, plist: ctx.plistPath, db: ctx.cookieDb, backupDir: ctx.backupDir },
  }
}

export function cookieVerdict(count) {
  if (count === null || count === undefined) return 'unknown'
  if (count >= DANGER_COOKIES) return 'danger'
  if (count >= WARN_COOKIES) return 'warn'
  return 'ok'
}

export function formatStatus(s) {
  const lines = []
  if (!s.supported) {
    lines.push('❌ 这个清理器依赖 macOS 的 launchd，当前平台不支持。')
    return lines.join('\n')
  }
  const la = s.launch
  if (s.python && !s.python.ok) lines.push(`⚠️ python3：${s.python.path} 不可执行——守护会反复启动失败`)
  lines.push(la.loaded
    ? `✅ 常驻守护：已加载（state = ${la.state}）`
    : `⚠️ 常驻守护：未加载${la.detail ? `（${la.detail}）` : ''}——现在退出 DSH 不会自动清理`)
  const c = s.cookies
  const verdict = cookieVerdict(c.count)
  const icon = verdict === 'danger' ? '❌' : verdict === 'warn' ? '⚠️' : verdict === 'ok' ? '✅' : '❔'
  const parts = [`${icon} cookie 条数：${c.count === null ? '读不到' : c.count}`]
  if (c.exists) {
    parts.push(`库大小：${(c.size / 1024).toFixed(1)} KB`)
    parts.push(`最后写入：${c.mtime}`)
  }
  lines.push(parts.join('　|　'))
  if (verdict === 'danger') lines.push('   条数已接近 72 条 / 16KB 的 431 阈值，尽快退出一次 DSH 触发清理。')
  else if (verdict === 'warn') lines.push('   条数偏多，退出 DSH 会自动清空；也可以手动跑一次 --once。')
  if (c.note) lines.push(`   备注：${c.note}`)
  lines.push(s.backups.length
    ? `📦 备份：保留 ${s.backups.length} 份（最新 ${s.backups[0].name}，${(s.backups[0].bytes / 1024).toFixed(1)} KB）`
    : '📦 备份：暂无')
  lines.push('🧾 最近日志：')
  if (s.log.length) for (const line of s.log) lines.push(`   ${line}`)
  else lines.push('   （还没有日志，守护可能从未触发过）')
  return lines.join('\n')
}

export async function install(ctx, opts = {}) {
  if (ctx.platform !== 'darwin') {
    return { ok: false, error: '这个清理器依赖 macOS 的 launchd，当前平台不支持。' }
  }
  if (!isExecutable(ctx.python)) {
    return { ok: false, error: `找不到可执行的 python3：${ctx.python}。先装 Command Line Tools（xcode-select --install）再试。` }
  }
  const keep = clampInt(opts.keepBackups, DEFAULTS.keepBackups, 1, 20)
  const grace = clampInt(opts.graceSeconds, DEFAULTS.graceSeconds, 1, 600)
  const poll = clampInt(opts.pollSeconds, DEFAULTS.pollSeconds, 1, 60)

  fs.mkdirSync(ctx.stateDir, { recursive: true })
  fs.mkdirSync(ctx.backupDir, { recursive: true })
  fs.mkdirSync(path.dirname(ctx.plistPath), { recursive: true })
  fs.copyFileSync(DAEMON_SRC, ctx.scriptPath)
  fs.chmodSync(ctx.scriptPath, 0o755)
  fs.writeFileSync(ctx.plistPath, plistXml(ctx, { keepBackups: keep, graceSeconds: grace, pollSeconds: poll }), 'utf8')

  const before = await launchState(ctx)
  if (before.loaded) {
    await ctx.run(ctx.launchctl, ['bootout', `gui/${ctx.uid}/${ctx.label}`])
    // bootout 是异步的：旧服务还挂在 domain 里时立刻 bootstrap 会拿到
    // "5: Input/output error"，而 print 仍会显示旧的 loaded——不等到它真消失，
    // 就会把「旧服务还在」误判成安装成功。
    const gone = await waitUntil(async () => !(await launchState(ctx)).loaded, ctx.bootoutTimeoutMs || 5000)
    if (!gone) {
      return { ok: false, replaced: true, error: '旧守护没能从 launchd 里退出（bootout 超时），先手动 launchctl bootout 再试' }
    }
  }

  let fallbackError = ''
  let loaded = false
  for (let attempt = 0; attempt < 3 && !loaded; attempt++) {
    if (attempt > 0) await sleep(400)
    const boot = await ctx.run(ctx.launchctl, ['bootstrap', `gui/${ctx.uid}`, ctx.plistPath])
    if (boot.code !== 0) {
      const legacy = await ctx.run(ctx.launchctl, ['load', '-w', ctx.plistPath])
      if (legacy.code !== 0) {
        fallbackError = [boot.stderr, legacy.stderr].filter(Boolean).join(' / ').trim()
      }
    }
    loaded = (await launchState(ctx)).loaded
  }

  const after = await launchState(ctx)
  return {
    ok: after.loaded,
    replaced: before.loaded,
    state: after.state,
    error: after.loaded ? '' : (fallbackError || 'launchctl 没有报告已加载，请用 status 复查'),
    python: ctx.python,
    scriptPath: ctx.scriptPath,
    plistPath: ctx.plistPath,
    backupDir: ctx.backupDir,
    keepBackups: keep,
    graceSeconds: grace,
    pollSeconds: poll,
  }
}

export function formatInstall(r) {
  if (!r.ok) return `❌ 安装失败：${r.error}`
  return [
    `${r.replaced ? '✅ 已重装（覆盖原有守护）' : '✅ 已安装'}`,
    `守护脚本：${r.scriptPath}`,
    `launchd 配置：${r.plistPath}`,
    `备份目录：${r.backupDir}`,
    `策略：保留 ${r.keepBackups} 份备份，退出 ${r.graceSeconds} 秒后清理，每 ${r.pollSeconds} 秒轮询一次`,
    '下次完全退出 DSH 时执行清理；现在 DSH 还在跑，库被占用，清理会等到退出之后。',
  ].join('\n')
}

export async function uninstall(ctx, opts = {}) {
  const was = await launchState(ctx)
  const removed = []
  if (was.loaded) {
    const r = await ctx.run(ctx.launchctl, ['bootout', `gui/${ctx.uid}/${ctx.label}`])
    if (r.code === 0) removed.push('launchd 服务')
    await waitUntil(async () => !(await launchState(ctx)).loaded, 5000)
  }
  if (fs.existsSync(ctx.plistPath)) {
    fs.rmSync(ctx.plistPath, { force: true })
    removed.push('plist')
  }
  const purged = Boolean(opts.purge)
  if (purged) {
    if (!isOurStateDir(ctx.stateDir)) {
      return { ok: false, error: `拒绝删除非预期目录：${ctx.stateDir}` }
    }
    fs.rmSync(ctx.stateDir, { recursive: true, force: true })
    removed.push('状态目录（含备份）')
  }
  const after = await launchState(ctx)
  return { ok: !after.loaded, removed, purged, stillLoaded: after.loaded }
}

export function formatUninstall(r) {
  if (!r.ok) return `❌ 卸载没干净：守护仍在加载状态。`
  if (!r.removed.length) return 'ℹ️ 本来就没装，没有改动任何东西。'
  return [
    '✅ 已卸载',
    `清掉：${r.removed.join('、')}`,
    r.purged ? '备份和日志一起删了。' : '备份和日志留着（在 ~/.dsh/dsh-cookie-cleaner，要清就加 purge）。',
  ].join('\n')
}
