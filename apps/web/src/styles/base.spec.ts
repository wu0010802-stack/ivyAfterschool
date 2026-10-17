import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// vitest 的 css ?raw 會回傳空字串，改用 fs 讀原始檔；happy-dom 量不到版面，以宣告鎖住
const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'base.css'), 'utf-8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

interface Rule {
  selector: string
  decls: string[]
}

/** 只解析頂層規則（base.css 沒有巢狀 @media 以外的區塊） */
function rules(source: string): Rule[] {
  const out: Rule[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  for (let m = re.exec(source); m; m = re.exec(source)) {
    out.push({
      selector: m[1]!.trim(),
      decls: m[2]!
        .split(';')
        .map((d) => d.trim().replace(/\s+/g, ' '))
        .filter(Boolean),
    })
  }
  return out
}

const MESSAGE_BOX_BUTTON = '.el-message-box__btns .el-button'

describe('base.css', () => {
  it('message box buttons meet touch target', () => {
    const rule = rules(css).find((r) => r.selector.split(',').map((s) => s.trim()).includes(MESSAGE_BOX_BUTTON))
    expect(rule, MESSAGE_BOX_BUTTON).toBeDefined()
    expect(rule!.decls).toContain('min-height: 44px')
    expect(rule!.decls).toContain('padding: 0 20px')
  })

  it('message box rule is not scoped to a component', () => {
    // 規則在全域 base.css（命令式 ElMessageBox 掛在 body 下，scoped style 碰不到）
    expect(css).not.toMatch(/:deep\(|\[data-v-/)
    // 只有確認框內的按鈕受影響：碰 .el-button 的規則一律以 .el-message-box__btns 起始
    const buttonSelectors = rules(css)
      .flatMap((r) => r.selector.split(',').map((s) => s.trim()))
      .filter((s) => /\.el-button\b/.test(s))
    expect(buttonSelectors).toEqual([MESSAGE_BOX_BUTTON])
  })
})
