// FRONTEND-024：後台 view 的延遲載入集中在這裡，routes.ts 只引用 VIEW_LOADERS.X。
// 初始全部指向 PlaceholderView；各 view task 完成時把自己的 loader 改為 `() => import('@/views/...')`。
import type { Component } from 'vue'

export type ViewName =
  | 'LoginView'
  | 'ChangePasswordView'
  | 'ErrorView'
  | 'DashboardView'
  | 'StudentWorkbenchView'
  | 'ClassesView'
  | 'AttendanceTodayView'
  | 'AttendanceMonthlyView'
  | 'LeavesView'
  | 'HomeworkBoardView'
  | 'PickupPosView'
  | 'PickupAuthorizationsView'
  | 'ExamsView'
  | 'ExamDetailView'
  | 'SystemSettingsView'
  | 'ReferenceDataView'
  | 'StaffAccountsView'
  | 'RolesView'
  | 'AuditLogView'

const placeholder = () => import('@/router/PlaceholderView.vue')

export const VIEW_LOADERS: Record<ViewName, () => Promise<Component>> = {
  LoginView: () => import('@/views/LoginView.vue'),
  ChangePasswordView: () => import('@/views/ChangePasswordView.vue'),
  ErrorView: () => import('@/views/ErrorView.vue'),
  DashboardView: () => import('@/views/DashboardView.vue'),
  StudentWorkbenchView: placeholder,
  ClassesView: () => import('@/views/ClassesView.vue'),
  AttendanceTodayView: placeholder,
  AttendanceMonthlyView: () => import('@/views/AttendanceMonthlyView.vue'),
  LeavesView: placeholder,
  HomeworkBoardView: placeholder,
  PickupPosView: placeholder,
  PickupAuthorizationsView: placeholder,
  ExamsView: () => import('@/views/ExamsView.vue'),
  ExamDetailView: placeholder,
  SystemSettingsView: () => import('@/views/settings/SystemSettingsView.vue'),
  ReferenceDataView: () => import('@/views/settings/ReferenceDataView.vue'),
  StaffAccountsView: placeholder,
  RolesView: () => import('@/views/settings/RolesView.vue'),
  AuditLogView: () => import('@/views/settings/AuditLogView.vue'),
}
