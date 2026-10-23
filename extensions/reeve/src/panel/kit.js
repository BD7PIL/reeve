// kit 的薄包装：`mount*(host, props)` → `{ node, handle }`，顺手把 `data-*` 钩子挂到真按钮上。
//
// 为什么包装：面板是纯 JS（没有 React），每次重画都要重建节点；把"建 host → mount → 取按钮节点"
// 这三步收成一个函数，调用点才读得懂（也才不容易漏掉 data-* —— 自动化是用选择器点按钮的）。
//
// 纪律：**控件一律用 kit**（按钮/徽标/列表/菜单/进度条/空态/分隔线/字段/选择/开关）。
// 自己画的控件会漂成"另一个 app 的样子"——上一版那套自绘的档位块与延迟条就是教训。

import {
  mountBadge, mountBanner, mountButton, mountCheckbox, mountEmpty, mountList, mountMenu,
  mountProgress, mountSearchField, mountSelect, mountSeparator, mountSpinner, mountTabs, mountTextField,
} from '@openchamber/sdk/ui'
// 图标模块在包里，但 `ui/index.js` 没有 re-export 它（实测）—— 直接按文件引，
// 免得自己再造一套图标（那正是"看起来像另一个 app"的老路）。
import { icon } from '@openchamber/sdk/dist/ui/icons.js'

import { el } from './util.js'

const host = (tag = 'span') => el(tag)

export function badge(props) {
  const node = host()
  const handle = mountBadge(node, props)
  return { node, handle }
}

export function button({ data, ...props }) {
  const node = host()
  const handle = mountButton(node, props)
  const btn = node.querySelector('button')
  if (btn && data) for (const [k, v] of Object.entries(data)) btn.setAttribute(k, v)
  return { node, handle, btn }
}

export function menu({ data, ...props }) {
  const node = host()
  const handle = mountMenu(node, props)
  const btn = node.querySelector('button')
  if (btn && data) for (const [k, v] of Object.entries(data)) btn.setAttribute(k, v)
  return { node, handle, btn }
}

export function list(props) {
  const node = host('div')
  const handle = mountList(node, props)
  return { node, handle }
}

export function empty(props) {
  const node = host('div')
  mountEmpty(node, props)
  return node
}

export function banner(props) {
  const node = host('div')
  mountBanner(node, props)
  return node
}

export function separator(props) {
  const node = host('div')
  mountSeparator(node, props)
  return node
}

export function progress(props) {
  const node = host('div')
  const handle = mountProgress(node, props)
  return { node, handle }
}

export function search(props) {
  const node = host()
  const handle = mountSearchField(node, props)
  return { node, handle }
}

export function select(props) {
  const node = host()
  const handle = mountSelect(node, props)
  return { node, handle }
}

export function field(props) {
  const node = host()
  const handle = mountTextField(node, props)
  return { node, handle }
}

export function checkbox(props) {
  const node = host()
  const handle = mountCheckbox(node, props)
  return { node, handle }
}

export function tabs(props) {
  const node = host('div')
  const handle = mountTabs(node, props)
  return { node, handle }
}

export function spinner(props = {}) {
  const node = host()
  mountSpinner(node, props)
  return node
}

/** 摘要卡里的一个数字格：小灰标签 + 粗体数字。 */
export const stat = (label, value, tone) =>
  el('div', {}, [
    el('div', { class: 'oc-stat-label', text: label }),
    el('div', { class: `oc-stat-value${tone ? ` oc-${tone}` : ''}`, text: value == null || value === '' ? '—' : String(value) }),
  ])

/** 一行小灰字（事实只写一次；不要用它与卡片标题重复）。 */
export const mutedLine = (text) => el('div', { class: 'oc-xs oc-off', text })

/** 让一个 kit 包装层在行里不要被 flex 拉变形。 */
export const inline = (node) => el('span', { class: 'oc-kit-inline' }, [node])
/** kit 自带的图标（remixicon 形状：search / chevron / check / close）。用它而不是自己画 SVG。 */
export const kitIcon = (root, name, size = 14, className = '') => {
  const svg = icon(name, size, className)
  root.append(svg)
  return root
}

/** 按钮 + 前置图标（宿主也这么拼：ghost xs + 图标 + 文本，或纯图标）。 */
export function iconButton({ iconName, label, ...props }) {
  const b = button({ label, ...props })
  const inner = b.node.querySelector('button')
  if (inner && iconName) inner.prepend(icon(iconName, 14))
  return b
}

/** 分区：标题行（小字灰色说明在右）+ 一组行。 */
export function section({ title, hint, body = [], headRight = null }) {
  const node = el('div', { class: 'oc-section oc-card' })
  const head = el('div', { class: 'oc-section-head' })
  head.append(el('span', { class: 'oc-label', text: title }))
  if (hint) head.append(el('span', { class: 'oc-micro oc-muted', text: hint }))
  if (headRight) {
    head.append(el('span', { class: 'oc-grow' }))
    head.append(headRight)
  }
  node.append(head)
  const box = el('div', { class: 'oc-section-body oc-divide' })
  for (const child of body) box.append(child)
  node.append(box)
  return node
}

/** 设置行：左（标签 + 说明）/ 右（控件）。 */
export function fieldRow({ label, description = null, control, extra = null }) {
  const row = el('div', { class: 'oc-field-row' })
  const main = el('div', { class: 'oc-field-main' })
  main.append(el('label', { class: 'oc-label oc-truncate', text: label }))
  if (description) main.append(el('span', { class: 'oc-micro oc-muted', text: description }))
  row.append(main)
  const right = el('div', { class: 'oc-field-control' })
  if (control) right.append(control)
  if (extra) right.append(extra)
  row.append(right)
  return row
}

/** 细线分隔（无标签）—— kit 的 mountSeparator 带文字；这里只要线。 */
export const hairline = () => el('div', { class: 'oc-divide-anchor', style: 'height:1px;background:var(--surface-subtle, var(--interactive-border))' })
