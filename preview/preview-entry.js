// 预览入口：注入真 kit 的样式，然后**原样加载真面板**（`../src/panel/main.js` 自己会跑 main()）。
//
// 保持"预览 = 线上同一套渲染"：这里只做两件线上由宿主做的事 —— 给 guest 样式、给 #root。

import { GUEST_UI_LOOK_CSS } from '@openchamber/sdk/ui'

const style = document.createElement('style')
style.textContent = GUEST_UI_LOOK_CSS
document.head.append(style)

await import('../src/panel/main.js')

// `?tab=stats|ledger`：真宿主是靠点击切 tab 的，预览也照做（点真按钮，不绕过面板状态）。
const want = new URLSearchParams(location.search).get('tab')
if (want && want !== 'chain') {
  const label = { chain: 'Chains', stats: 'Stats', ledger: 'Tasks' }[want]
  const clickTab = () => {
    const btn = [...document.querySelectorAll('#root button')].find((b) => b.textContent?.trim().startsWith(label))
    if (btn) {
      btn.click()
      return true
    }
    return false
  }
  if (!clickTab()) setTimeout(clickTab, 150)
}