// PARENT-190：家長端 e2e 共用替身。e2e 不接真實後端：
// - LIFF：addInitScript 注入 window.__PARENT_LIFF_MOCK__（PARENT-008 非 production build 才會使用）。
// - API：page.route 攔截 /api/parent/**，以有狀態的 ParentApi 回應（綁定前 /parent/me 401 → 綁定後 200）。
// - WebSocket：page.routeWebSocket 攔截 /api/ws/parent，連上即回 ready，測試中再以 push() 推送事件。
// - 時間：page.clock 固定在台北 2026-10-07（三）17:22，今日接送請求的 service_date 才對得上前端的「今天」。
// 型別在這裡自行宣告最小欄位（e2e 走 tsconfig.node，不引用 src 的 @/ 路徑）。
import { expect, test as base, type Page, type Route, type WebSocketRoute } from '@playwright/test'

export const TODAY = '2026-10-07'
export const NOW = new Date('2026-10-07T09:22:00Z')
export const ID_TOKEN = 'e2e-id-token'

export interface ChildSummary {
  id: string
  name: string
  grade_level: number
  class_name: string | null
  school_name: string | null
  photo_url: string | null
  status: 'active' | 'suspended'
}

export interface ParentMe {
  id: string
  display_name: string | null
  picture_url: string | null
  phone: string | null
  children: ChildSummary[]
}

export interface PickupRequest {
  id: string
  student_id: string
  student_name: string
  service_date: string
  status: 'pending' | 'acknowledged' | 'arrived' | 'completed' | 'cancelled' | 'expired'
  expected_arrival_at: string | null
  reply_ready_eta: string | null
  reply_message: string | null
  reply_source: 'auto' | 'staff' | null
  replied_at: string | null
  arrived_at: string | null
  completed_at: string | null
  picked_up_by_name: string | null
  cancelled_at: string | null
  created_at: string
  can_cancel: boolean
  can_mark_arrived: boolean
}

export interface Reply {
  status: number
  body: unknown
}

export interface RecordedCall {
  method: string
  path: string
  body: unknown
}

export const CHILD: ChildSummary = {
  id: 's1',
  name: '王小明',
  grade_level: 3,
  class_name: '中年級 A 班',
  school_name: '某某國小',
  photo_url: null,
  status: 'active',
}

export const ME: ParentMe = {
  id: 'p1',
  display_name: '王媽媽',
  picture_url: null,
  phone: '0912-000-123',
  children: [CHILD],
}

export const CONFIG = {
  liff_id: 'e2e-liff-id',
  org_name: '快樂安親班',
  org_phone: '02-2345-6789',
  logo_url: null,
  // null：首綁成功直接回首頁（有加好友網址時會先停在成功畫面）
  add_friend_url: null,
  limits: {
    leave_past_days: 30,
    leave_future_days: 60,
    leave_max_attachments: 3,
    leave_max_attachment_mb: 10,
    authorization_max_days_ahead: 14,
    persons_max: 10,
  },
}

/** 首頁今日狀態：已到班、作業 1/3、沒有接送請求 */
export const CHILD_TODAY = {
  student_id: CHILD.id,
  date: TODAY,
  is_service_day: true,
  attendance: { status: 'present', check_in_at: '2026-10-07T07:40:00Z', check_out_at: null },
  on_leave: false,
  leave: null,
  homework: { item_count: 3, done_count: 1, overall_status: 'in_progress', ready_eta: '17:30', note: null },
  pickup_request: null,
}

export const HOMEWORK = {
  student_id: CHILD.id,
  date: TODAY,
  items: [
    { title: '國語習作', subject_name: '國語', status: 'done' },
    { title: '數學習作', subject_name: '數學', status: 'doing' },
    { title: '英文單字', subject_name: '英文', status: 'todo' },
  ],
  overall_status: 'in_progress',
  ready_eta: '17:30',
  note: null,
  updated_at: '2026-10-07T09:00:00Z',
}

export function pickupRequest(id: string, overrides: Partial<PickupRequest> = {}): PickupRequest {
  return {
    id,
    student_id: CHILD.id,
    student_name: CHILD.name,
    service_date: TODAY,
    status: 'pending',
    expected_arrival_at: null,
    reply_ready_eta: null,
    reply_message: null,
    reply_source: null,
    replied_at: null,
    arrived_at: null,
    completed_at: null,
    picked_up_by_name: null,
    cancelled_at: null,
    created_at: NOW.toISOString(),
    can_cancel: true,
    can_mark_arrived: true,
    ...overrides,
  }
}

export function apiError(status: number, code: string, message: string): Reply {
  return { status, body: { error: { code, message, details: null } } }
}

const UNAUTHENTICATED = apiError(401, 'unauthenticated', '請重新登入')

/**
 * 家長端 API 與 WebSocket 的有狀態替身。預設：未登入、liff-login 回 needs_binding、綁定成功、今日沒有接送請求。
 * 測試在 goto 之前調整欄位；寫入的請求記在 calls，未預期的請求記在 unexpected 並回 404。
 */
export class ParentApi {
  /** 是否持有 parent_access（/parent/me、refresh 的回應依此決定） */
  authed = false
  liffLogin: { status: 'ok' | 'needs_binding'; parent: ParentMe | null; name_hint: string | null } = {
    status: 'needs_binding',
    parent: null,
    name_hint: '王媽媽',
  }
  /** null：綁定成功（之後 authed） */
  bindReply: Reply | null = null
  todayRequests: PickupRequest[] = []
  /** POST /parent/pickup/requests 的回應；預設依 body 建立一筆 pending */
  createReply: (body: Record<string, unknown>) => Reply = (body) => ({
    status: 201,
    body: pickupRequest('r1', body.arrived === true ? { status: 'arrived', can_mark_arrived: false } : {}),
  })

  readonly calls: RecordedCall[] = []
  readonly unexpected: string[] = []
  readonly sockets: WebSocketRoute[] = []

  constructor(private readonly page: Page) {}

  async install(): Promise<void> {
    await this.page.clock.setFixedTime(NOW)
    await this.page.addInitScript((idToken) => {
      const calls = { login: [] as unknown[], logout: 0 }
      Object.assign(globalThis, {
        __PARENT_LIFF_MOCK_CALLS__: calls,
        __PARENT_LIFF_MOCK__: {
          isLoggedIn: () => true,
          isInClient: () => true,
          getIDToken: () => idToken,
          getDecodedIDToken: () => ({ exp: 9999999999 }),
          login: (opts: unknown) => {
            calls.login.push(opts)
          },
          logout: () => {
            calls.logout += 1
          },
        },
      })
    }, ID_TOKEN)
    await this.page.route('**/api/parent/**', (route) => this.handle(route))
    await this.page.routeWebSocket('**/api/ws/parent', (ws) => {
      this.sockets.push(ws)
      ws.send(JSON.stringify({ type: 'ready', children: [CHILD.id] }))
    })
  }

  /** 對最近一條 ws 連線推送事件（信封同 BACKEND-227：type / data / sent_at） */
  async push(type: string, data: unknown): Promise<void> {
    await expect.poll(() => this.sockets.length, { message: 'ws 尚未連線' }).toBeGreaterThan(0)
    this.sockets.at(-1)!.send(JSON.stringify({ type, data, sent_at: NOW.toISOString() }))
  }

  callsTo(method: string, path: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method && c.path === path)
  }

  /** LIFF 替身的 login / logout 呼叫紀錄 */
  liffCalls(): Promise<{ login: unknown[]; logout: number }> {
    return this.page.evaluate(
      () => (globalThis as unknown as { __PARENT_LIFF_MOCK_CALLS__: { login: unknown[]; logout: number } }).__PARENT_LIFF_MOCK_CALLS__,
    )
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request()
    const method = request.method()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    let body: unknown = null
    try {
      body = request.postDataJSON()
    } catch {
      body = request.postData()
    }
    this.calls.push({ method, path, body })
    const reply = this.reply(method, path, (body ?? {}) as Record<string, unknown>)
    if (reply === null) this.unexpected.push(`${method} ${path}`)
    const { status, body: payload } = reply ?? apiError(404, 'not_found', `e2e 替身沒有處理 ${method} ${path}`)
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })
  }

  private reply(method: string, path: string, body: Record<string, unknown>): Reply | null {
    const key = `${method} ${path}`
    switch (key) {
      case 'GET /parent/config':
        return { status: 200, body: CONFIG }
      case 'GET /parent/me':
        return this.authed ? { status: 200, body: ME } : UNAUTHENTICATED
      case 'POST /parent/auth/refresh':
        return this.authed ? { status: 200, body: {} } : UNAUTHENTICATED
      case 'POST /parent/auth/liff-login':
        if (this.liffLogin.status === 'ok') this.authed = true
        return { status: 200, body: this.liffLogin }
      case 'POST /parent/auth/bind':
        if (this.bindReply) return this.bindReply
        this.authed = true
        return { status: 200, body: { parent: ME } }
      case 'GET /parent/children':
        return { status: 200, body: [CHILD] }
      case `GET /parent/children/${CHILD.id}`:
        return {
          status: 200,
          body: {
            ...CHILD,
            school_class: null,
            enrolled_on: null,
            my_guardian: { relation: 'mother', is_primary: true, can_pickup: true, receives_notifications: true },
          },
        }
      case `GET /parent/children/${CHILD.id}/today`:
        return { status: 200, body: CHILD_TODAY }
      case `GET /parent/children/${CHILD.id}/homework`:
        return { status: 200, body: HOMEWORK }
      case 'GET /parent/pickup/requests/today':
        return { status: 200, body: this.todayRequests }
      case 'POST /parent/pickup/requests': {
        const reply = this.createReply(body)
        if (reply.status < 300) this.todayRequests = [...this.todayRequests, reply.body as PickupRequest]
        return reply
      }
      case 'GET /parent/notifications':
        return { status: 200, body: { items: [], total: 0, unread_count: 0 } }
      default:
        return null
    }
  }
}

export const test = base.extend<{ api: ParentApi }>({
  api: async ({ page }, use) => {
    const api = new ParentApi(page)
    await api.install()
    await use(api)
  },
})

export { expect }
