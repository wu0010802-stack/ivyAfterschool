// FRONTEND-028：後台入口。Element Plus 樣式先載入，全域基底樣式在後（覆寫 body 預設值）。
import 'element-plus/dist/index.css'
import '@/styles/base.css'
import { createAdminApp } from '@/bootstrap'

createAdminApp().app.mount('#app')
