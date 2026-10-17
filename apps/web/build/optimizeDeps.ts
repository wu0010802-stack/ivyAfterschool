// INFRA-055：dev server 啟動時就預打包的依賴（vite.config.ts 的 optimizeDeps.include）。
// unplugin-vue-components 依「這次用到的元件」才 import element-plus 的樣式，冷快取時進到新頁面才發現新依賴，
// vite 重新預打包並整頁重載（optimized dependencies changed. reloading），打斷 e2e 換頁與使用中的頁面。
// 列出 element-plus 全部有 style/css 的元件（id 與 unplugin 產生的 import 相同；optimizeDeps 的 glob 不展開
// 這種無副檔名的 exports 子路徑），新頁面用到新元件也不必再改這裡。
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EP_COMPONENTS_DIR = fileURLToPath(new URL('../node_modules/element-plus/es/components', import.meta.url))

export function elementPlusStyleDeps(dir: string = EP_COMPONENTS_DIR): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'style', 'css.mjs')))
    .map((entry) => `element-plus/es/components/${entry.name}/style/css`)
    .sort()
}

export const OPTIMIZE_DEPS_INCLUDE: string[] = elementPlusStyleDeps()
