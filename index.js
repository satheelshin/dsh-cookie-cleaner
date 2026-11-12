// DSH 插件入口：把 DSH cookie 常驻清理器的安装 / 诊断 / 卸载做成 4 个工具。
// 真正的「退出后清理」由 launchd 常驻的 daemon/monitor.py 干——插件活在 DSH
// 进程里，DSH 一退它就没了，所以插件只当管理器，不假装自己能清理。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultContext, formatInstall, formatStatus, formatUninstall, install, status, uninstall, logTail } from './lib/manager.mjs'

export const name = 'dsh-cookie-cleaner'
export const inject = ['tools']

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const asText = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

function obj(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

export function apply(ctx) {
  const tools = [
    {
      name: 'cookie_cleaner_status',
      description: '看 DSH cookie 清理器现在是什么状态：launchd 守护是否加载、cookie 库有多少条（多少条接近 431 阈值）、备份和最近日志。排查 "Web authentication failed" 先跑这个。',
      parameters: obj({}),
      async execute() {
        const st = await status(defaultContext())
        return `DSH cookie 清理器 v${VERSION}\n${formatStatus(st)}`
      },
    },
    {
      name: 'cookie_cleaner_install',
      description: '安装（或重装/修复）常驻清理器：把守护脚本写到 ~/.dsh/dsh-cookie-cleaner，生成 launchd plist 并加载。之后每次完全退出 DSH 都会先备份再清空 cookie 库。重复执行等于修复，不会重复加载。',
      parameters: obj({
        keepBackups: { type: 'number', description: '保留几份备份，1–20，默认 3' },
        graceSeconds: { type: 'number', description: 'DSH 退出后等几秒再清理，1–600，默认 5' },
        pollSeconds: { type: 'number', description: '轮询间隔秒数，1–60，默认 3' },
      }),
      async execute(args = {}) {
        const result = await install(defaultContext(), args)
        return formatInstall(result)
      },
    },
    {
      name: 'cookie_cleaner_uninstall',
      description: '卸载常驻清理器：停掉并移除 launchd 服务与 plist。默认保留 ~/.dsh/dsh-cookie-cleaner 里的备份和日志，purge 传 true 才一起删。',
      parameters: obj({
        purge: { type: 'boolean', description: '连备份和日志一起删，默认 false' },
      }),
      async execute(args = {}) {
        const result = await uninstall(defaultContext(), { purge: Boolean(args.purge) })
        return formatUninstall(result)
      },
    },
    {
      name: 'cookie_cleaner_log',
      description: '读常驻清理器的最近日志，看它什么时候清理过、清了几条、备份到哪。',
      parameters: obj({
        lines: { type: 'number', description: '看最近几行，默认 20，最多 200' },
      }),
      async execute(args = {}) {
        const n = Math.min(200, Math.max(1, Math.round(Number(args.lines) || 20)))
        const lines = logTail(defaultContext(), n)
        if (!lines.length) return '还没有日志：守护没跑过，或者日志被删了。先 cookie_cleaner_install。'
        return lines.join('\n')
      },
    },
  ]

  for (const t of tools) {
    const { execute, ...def } = t
    ctx.effect(
      () =>
        ctx.tools.register({
          ...def,
          output: { schema: {}, render: (_a, value) => asText(value) },
          execute,
        }),
      `dsh-cookie-cleaner: ${t.name}`,
    )
  }
}
