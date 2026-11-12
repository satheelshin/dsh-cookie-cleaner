// 用假的 Cordis ctx 验证插件入口能加载、四个工具都注册上。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../index.js'

function fakeCtx() {
  const registered = []
  const effects = []
  return {
    registered,
    effects,
    tools: {
      register(def) {
        registered.push(def)
        return () => {}
      },
    },
    effect(fn, label) {
      effects.push(label)
      return fn()
    },
  }
}

test('插件导出 apply / name / inject', () => {
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.name, 'dsh-cookie-cleaner')
  assert.deepEqual(plugin.inject, ['tools'])
})

test('apply 注册四个工具，参数 schema 合法', () => {
  const ctx = fakeCtx()
  plugin.apply(ctx)
  const names = ctx.registered.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'cookie_cleaner_install',
    'cookie_cleaner_log',
    'cookie_cleaner_status',
    'cookie_cleaner_uninstall',
  ])
  for (const tool of ctx.registered) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.ok(tool.description.length > 10)
  }
  assert.equal(ctx.effects.length, 4)
})

test('install 工具参数都在 schema 里声明', () => {
  const ctx = fakeCtx()
  plugin.apply(ctx)
  const install = ctx.registered.find((t) => t.name === 'cookie_cleaner_install')
  assert.deepEqual(Object.keys(install.parameters.properties).sort(), [
    'graceSeconds',
    'keepBackups',
    'pollSeconds',
  ])
})
