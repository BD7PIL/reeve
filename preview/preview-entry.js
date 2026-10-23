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
  // 语言跟随宿主：两种语言的 tab 文案都要能点到
  const labels = { chain: ['Chains', '链'], stats: ['Stats', '统计'], ledger: ['Tasks', '任务'] }[want] ?? []
  const clickTab = () => {
    const btn = [...document.querySelectorAll('#root button')].find((b) => labels.some((l) => b.textContent?.trim().startsWith(l)))
    if (btn) {
      btn.click()
      return true
    }
    return false
  }
  // 宿主 locale 在 onReady 后才生效，标签可能晚一拍才变中文
  if (!clickTab()) {
    let tries = 0
    const timer = setInterval(() => {
      if (clickTab() || ++tries > 20) clearInterval(timer)
    }, 100)
  }
}