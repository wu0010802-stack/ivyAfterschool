import { flushPromises } from '@vue/test-utils'
import axios from 'axios'
import type MockAdapter from 'axios-mock-adapter'
import { ElMessageBox } from 'element-plus'
import zhTw from 'element-plus/es/locale/lang/zh-tw'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createMemoryHistory, START_LOCATION } from 'vue-router'
import type { StaffMe } from '@/api/auth'
import { adminHttp, resetAdminHttpHandlers, triggerAuthFailure } from '@/api/http'
import { ApiError } from '@/shared/types/api'
import { useAuthStore } from '@/stores/auth'
import { createApiMock } from '@/test/helpers'
import { createAdminApp } from './bootstrap'

// 不載入真實 view：routes.ts 的每個 loader 都換成同一個 stub 元件
vi.mock('@/router/viewLoaders', async () => {
  const { h } = await import('vue')
  const ViewStub = { name: 'ViewStub', render: () => h('div', { 'data-test': 'view-stub' }, '頁面內容') }
  return { VIEW_LOADERS: new Proxy({}, { get: () => () => Promise.resolve(ViewStub) }) }
})

const here = dirname(fileURLToPath(import.meta.url))

const USER: StaffMe = {
  id: 'u1',
  username: 'clerk01',
  display_name: '林行政',
  role: { id: 'r-clerk', code: 'clerk', name: '行政' },
  permissions: ['students:read', 'classes:read'],
  must_change_password: false,
}

const unauthorized = { error: { code: 'unauthorized', message: '請重新登入', details: null } }

let mock: MockAdapter

/** 建好 app 並以已登入身分停在 path */
async function startAt(path: string) {
  const created = createAdminApp({ history: createMemoryHistory() })
  useAuthStore(created.pinia).setUser(USER)
  await created.router.push(path)
  await created.router.isReady()
  return created
}

describe('createAdminApp', () => {
  beforeEach(() => {
    mock = createApiMock(adminHttp)
  })

  afterEach(() => {
    mock.restore()
    resetAdminHttpHandlers()
    document.body.innerHTML = ''
  })

  it('createAdminApp auth failure resets store and redirects', async () => {
    const { router, pinia } = await startAt('/students')
    mock.onGet('/admin/classes').reply(401, unauthorized)
    mock.onPost('/admin/auth/refresh').reply(401, unauthorized)

    const err = await adminHttp.get('/admin/classes').catch((e: unknown) => e)
    await flushPromises()

    expect(err).toBeInstanceOf(ApiError)
    expect(mock.history.post.map((r) => r.url)).toEqual(['/admin/auth/refresh'])
    expect(useAuthStore(pinia).status).toBe('anonymous')
    expect(useAuthStore(pinia).user).toBeNull()
    expect(router.currentRoute.value.fullPath).toBe('/login?redirect=/students')
  })

  it('createAdminApp auth failure from ws close also redirects with the current page', async () => {
    const { router, pinia } = await startAt('/classes?academic_year=115')

    triggerAuthFailure()
    await flushPromises()

    expect(useAuthStore(pinia).status).toBe('anonymous')
    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.query.redirect).toBe('/classes?academic_year=115')
  })

  it('createAdminApp auth failure on a public page only clears the session', async () => {
    const created = createAdminApp({ history: createMemoryHistory() })
    await created.router.push('/login')
    await created.router.isReady()
    useAuthStore(created.pinia).setUser(USER)

    triggerAuthFailure()
    await flushPromises()

    expect(useAuthStore(created.pinia).status).toBe('anonymous')
    expect(created.router.currentRoute.value.fullPath).toBe('/login')
  })

  it('createAdminApp auth failure before the first navigation leaves routing to the guard', async () => {
    const created = createAdminApp({ history: createMemoryHistory() })
    useAuthStore(created.pinia).setUser(USER)
    const replace = vi.spyOn(created.router, 'replace')

    triggerAuthFailure()
    await flushPromises()

    // handler 當下第一次導航（app.use(router) 啟動的 '/'）還沒完成：不另外 replace，由 authGuard 看到未登入導向 /login
    expect(useAuthStore(created.pinia).status).toBe('anonymous')
    expect(replace).not.toHaveBeenCalled()
    expect(created.router.currentRoute.value).not.toBe(START_LOCATION)
    expect(created.router.currentRoute.value.fullPath).toBe('/login')
  })

  it('createAdminApp refresh handler updates permissions', async () => {
    const { pinia } = await startAt('/students')
    mock.onGet('/admin/students').replyOnce(401, unauthorized)
    mock.onPost('/admin/auth/refresh').replyOnce(200, {
      user: { ...USER, permissions: ['students:read', 'students:write'] },
    })
    mock.onGet('/admin/students').replyOnce(200, { items: [], total: 0 })
    const auth = useAuthStore(pinia)
    expect(auth.hasPermission('students:write')).toBe(false)

    const res = await adminHttp.get('/admin/students')

    expect(res.data).toEqual({ items: [], total: 0 })
    expect(mock.history.get).toHaveLength(2)
    expect(auth.hasPermission('students:write')).toBe(true)
    expect(auth.hasPermission('classes:read')).toBe(false)
    expect(auth.status).toBe('authenticated')
  })

  it('createAdminApp password change required redirects', async () => {
    const { router } = await startAt('/students')
    mock.onGet('/admin/students').reply(403, {
      error: { code: 'password_change_required', message: '請先修改密碼', details: null },
    })

    const err = await adminHttp.get('/admin/students').catch((e: unknown) => e)
    await flushPromises()

    expect((err as ApiError).code).toBe('password_change_required')
    expect(router.currentRoute.value.path).toBe('/change-password')
  })

  it('createAdminApp shows uncaught errors as a message except cancellations', async () => {
    const { app } = createAdminApp({ history: createMemoryHistory() })
    const handler = app.config.errorHandler
    expect(typeof handler).toBe('function')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    handler?.(new ApiError(500, 'internal_error', '伺服器暫時無法處理'), null, 'setup function')
    await nextTick()
    expect(document.body.textContent).toContain('伺服器暫時無法處理')

    handler?.(new Error('TypeError: x is undefined'), null, 'render function')
    await nextTick()
    expect(document.body.textContent).toContain('發生未預期的錯誤')
    expect(document.body.textContent).not.toContain('x is undefined')

    const before = document.querySelectorAll('.el-message').length
    handler?.(new axios.CanceledError(), null, 'setup function')
    await nextTick()
    expect(document.querySelectorAll('.el-message')).toHaveLength(before)
    expect(consoleError).toHaveBeenCalledTimes(2)
  })

  it('createAdminApp sets zh-tw for imperative message boxes', async () => {
    createAdminApp({ history: createMemoryHistory() })
    // 字串取自 locale 物件；確認與預設英文不同，斷言才有意義
    expect(zhTw.el.messagebox.confirm).not.toBe('OK')

    const result = ElMessageBox.confirm('確定要刪除嗎？', '刪除').catch((action: unknown) => action)
    await nextTick()
    await flushPromises()

    const buttons = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.el-message-box__btns button'))
    expect(buttons.map((btn) => btn.textContent?.trim())).toEqual([zhTw.el.messagebox.cancel, zhTw.el.messagebox.confirm])

    buttons[0]?.click()
    expect(await result).toBe('cancel')
  })

  it('createAdminApp mounts the app shell with router and pinia', async () => {
    const { app, router } = createAdminApp({ history: createMemoryHistory() })
    await router.push('/login')
    await router.isReady()
    const host = document.createElement('div')
    document.body.appendChild(host)

    app.mount(host)
    await flushPromises()

    expect(host.querySelector('[data-test=view-stub]')?.textContent).toBe('頁面內容')
    expect(host.querySelector('[data-test=admin-sidebar]')).toBeNull()
    expect(document.title).toBe('登入 - 安親班管理系統')
    app.unmount()
  })

  it('createAdminApp loads global base styles', () => {
    const base = readFileSync(resolve(here, 'styles/base.css'), 'utf8')
    const main = readFileSync(resolve(here, 'main.ts'), 'utf8')

    expect(base).toMatch(/body\s*\{[^}]*margin:\s*0/)
    expect(base).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{[^}]*box-sizing:\s*border-box/)
    expect(base).toMatch(/body\s*\{[^}]*font-family:\s*var\(--el-font-family\)/)
    expect(base).toMatch(/body\s*\{[^}]*color:\s*var\(--el-text-color-primary\)/)
    expect(base).toMatch(/body\s*\{[^}]*background:\s*var\(--el-bg-color-page\)/)

    const elementPlusCss = main.indexOf("import 'element-plus/dist/index.css'")
    const baseCss = main.indexOf("import '@/styles/base.css'")
    expect(elementPlusCss).toBeGreaterThanOrEqual(0)
    expect(baseCss).toBeGreaterThan(elementPlusCss)
    expect(main).toMatch(/createAdminApp\(\)\.app\.mount\('#app'\)/)
  })
})
