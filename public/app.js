'use strict'

/**
 * edgeMark 前端。
 *
 * 界面分工：
 *   左  所见即所得（Vditor IR 模式）—— 就是 MarkText 那种直接编辑排版结果的界面
 *   右  「源码 / AI 助手」两个页签 —— 源码是可编辑的原始 markdown，与左侧双向同步
 *
 * 内容真源：
 *   每个标签持有一个 CodeMirror.Doc（右侧源码面板），它是该文件内容的唯一真源。
 *   Vditor 是它的一个视图。
 *
 * 双向同步与死循环防护：
 *   两侧任一变化都会推给另一侧，`state.syncing` 用来阻断回环。
 *   Vditor → 源码：立即同步，这样 doc 永远是最新的，保存时直接取 doc 即可。
 *   源码 → Vditor：防抖 250ms，因为重渲染整个 Vditor 文档代价较高。
 */

// ---------------------------------------------------------------- 状态

const state = {
  root: null,
  /** [{ id, path, name, doc, savedContent, dirty }] */
  tabs: [],
  activeId: null,
  /** 正在做跨面板同步，忽略由此产生的事件 */
  syncing: false,
  /** 没有打开任何文件时给源码面板用的空文档 */
  scratchDoc: null
}

let tabSeq = 0

const activeTab = () => state.tabs.find((t) => t.id === state.activeId) || null

// ---------------------------------------------------------------- DOM

const $ = (sel) => document.querySelector(sel)

const els = {
  // 目录树
  tree: $('#tree'),
  btnNewFile: $('#btn-new-file'),
  btnNewDir: $('#btn-new-dir'),
  btnRefreshTree: $('#btn-refresh-tree'),

  // 名称输入框（新建 / 重命名共用）
  nameDialog: $('#name-dialog'),
  nameForm: $('#name-dialog form'),
  nameTitle: $('#name-title'),
  nameHint: $('#name-hint'),
  nameInput: $('#name-input'),
  nameError: $('#name-error'),
  nameCancel: $('#name-cancel'),

  rootLabel: document.querySelector('.root-label'),
  btnRoot: $('#btn-root'),
  btnSave: $('#btn-save'),
  status: $('#status'),
  currentPath: $('#current-path'),
  wysiwyg: $('#wysiwyg'),
  wysiwygNotice: $('#wysiwyg-notice'),

  // 标签栏
  tabbar: $('#tabbar'),
  tabs: $('#tabs'),
  btnTabList: $('#btn-tab-list'),
  tabListPanel: $('#tab-list-panel'),

  // 工具栏「更多」菜单
  btnMore: $('#btn-more'),
  moreMenu: $('#more-menu'),
  menuTheme: $('#menu-theme'),
  menuAutosave: $('#menu-autosave'),
  menuExportHtml: $('#menu-export-html'),
  menuExportPdf: $('#menu-export-pdf'),

  // 全文搜索
  btnSearch: $('#btn-search'),
  searchBar: $('#search-bar'),
  searchInput: $('#search-input'),
  btnSearchClose: $('#btn-search-close'),
  searchResults: $('#search-results'),

  // 目录树右键菜单
  contextMenu: $('#context-menu'),

  // 右侧面板
  source: $('#source'),
  ptabSource: $('#ptab-source'),
  ptabAi: $('#ptab-ai'),
  btnAiSettings: $('#btn-ai-settings'),

  // 根目录对话框
  dialog: $('#root-dialog'),
  rootForm: $('#root-dialog form'),
  rootInput: $('#root-input'),
  rootShortcuts: $('#root-shortcuts'),
  rootRecent: $('#root-recent'),
  rootError: $('#root-error'),
  rootCancel: $('#root-cancel'),

  // AI 对话
  aiPanel: $('#ai-panel'),
  aiMessages: $('#ai-messages'),
  aiForm: $('#ai-form'),
  aiInput: $('#ai-input'),
  btnAiSend: $('#btn-ai-send'),
  btnAiClear: $('#btn-ai-clear'),

  // AI 设置
  aiDialog: $('#ai-dialog'),
  aiFormSettings: $('#ai-dialog form'),
  aiBase: $('#ai-base'),
  aiModel: $('#ai-model'),
  aiKey: $('#ai-key'),
  aiKeyNote: $('#ai-key-note'),
  aiError: $('#ai-error'),
  btnAiKeyClear: $('#ai-key-clear'),
  btnAiTest: $('#ai-test'),
  aiCancel: $('#ai-cancel')
}

els.rootCancel.addEventListener('click', () => els.dialog.close())

// ---------------------------------------------------------------- 接口

async function request(method, url, { params, body } = {}) {
  if (params) {
    const qs = new URLSearchParams(params).toString()
    url += (url.includes('?') ? '&' : '?') + qs
  }

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `${method} ${url} 失败（${res.status}）`)
  return data
}

const api = {
  get: (url, params) => request('GET', url, { params }),
  put: (url, body) => request('PUT', url, { body }),
  post: (url, body) => request('POST', url, { body }),
  del: (url, body) => request('DELETE', url, { body })
}

// ---------------------------------------------------------------- markdown 渲染

// 只用于把 AI 回答渲染成 HTML；左侧排版由 Vditor 自己负责
const md = window
  .markdownit({ html: false, linkify: true, breaks: false })
  .use(function prismHighlight(markdownit) {
    markdownit.options.highlight = (code, lang) => {
      const language = lang && window.Prism.languages[lang] ? lang : null
      if (!language) return ''
      try {
        return window.Prism.highlight(code, window.Prism.languages[language], language)
      } catch {
        return ''
      }
    }
  })

// ---------------------------------------------------------------- 右侧源码面板

const sourceEditor = window.CodeMirror.fromTextArea($('#source'), {
  mode: 'gfm',
  theme: 'eclipse',
  lineWrapping: true,
  styleActiveLine: true,
  lineNumbers: true,
  tabSize: 2,
  indentUnit: 2
  // 注意：不要设 viewportMargin: Infinity —— 那会让 CodeMirror 把整个文档
  // 都渲染成 DOM（而不是只渲染可视区域），大文件下会直接把页面卡死。
})

// 保存是全局快捷键，见下方 window 上的 keydown（不能只绑在 CodeMirror 上，
// 否则焦点在左侧所见即所得面板时按 Cmd+S 不生效，还会弹出浏览器的「保存网页」）
sourceEditor.setOption('extraKeys', {
  Enter: 'newlineAndIndentContinueMarkdownList'
})

let sourceSyncTimer = null

const sourceWrapper = sourceEditor.getWrapperElement()

sourceEditor.on('change', () => {
  if (state.syncing) return

  const tab = activeTab()
  if (!tab) return

  refreshDirty(tab, sourceEditor.getValue())
  scheduleAutosave()
  scheduleWysiwygSync()
})

function scheduleWysiwygSync() {
  clearTimeout(sourceSyncTimer)
  // 防抖长一点：每次都要让 Vditor 重新解析并重建 DOM，大文档下代价很高
  sourceSyncTimer = setTimeout(pushToWysiwyg, 600)
}

async function pushToWysiwyg() {
  if (state.syncing) return
  await syncToWysiwyg(sourceEditor.getValue(), false)
}

/**
 * 把新内容写进源码面板。
 *
 * 不能直接 setValue —— 那会重建整个文档的 DOM，大文件下每敲一个字都会卡死。
 * 这里只找出真正变化的那一段，用 replaceRange 做局部替换，
 * 代价从 O(全文) 降到 O(改动长度)。
 */
function applyToSource(value) {
  const doc = sourceEditor.getDoc()
  const old = doc.getValue()
  if (old === value) return

  // 公共前缀
  const maxPrefix = Math.min(old.length, value.length)
  let start = 0
  while (start < maxPrefix && old.charCodeAt(start) === value.charCodeAt(start)) start++

  // 公共后缀
  let endOld = old.length
  let endNew = value.length
  while (endOld > start && endNew > start && old.charCodeAt(endOld - 1) === value.charCodeAt(endNew - 1)) {
    endOld--
    endNew--
  }

  doc.replaceRange(value.slice(start, endNew), doc.posFromIndex(start), doc.posFromIndex(endOld))
}

// ---------------------------------------------------------------- 左侧所见即所得

let resolveVditorReady = null
const vditorReady = new Promise((resolve) => {
  resolveVditorReady = resolve
})

const vditor = new window.Vditor('wysiwyg', {
  mode: 'ir',
  // 指向本地 vendor，配合已拷贝的 dist 目录可完全离线运行
  cdn: '/vendor/vditor',
  lang: 'zh_CN',
  icon: 'ant',
  // 直接按保存的偏好初始化，避免先亮一下再切
  theme: readPref(PREF_KEYS.theme, 'light') === 'dark' ? 'dark' : 'classic',
  height: '100%',
  value: '',
  placeholder: '从左侧目录里选一个文件…',
  // 关键：Vditor 默认会用 localStorage 缓存内容，那样会覆盖我们按文件加载的内容
  cache: { enable: false },
  counter: { enable: false },
  // 去掉会切换编辑模式的（edit-mode/both/preview）和依赖上传服务的（upload/record）
  toolbar: [
    'emoji', 'headings', 'bold', 'italic', 'strike', '|',
    'list', 'ordered-list', 'check', 'outdent', 'indent', '|',
    'quote', 'line', 'code', 'inline-code', '|',
    'link', 'table', '|',
    'undo', 'redo', '|',
    'fullscreen', 'outline'
  ],
  after() {
    if (resolveVditorReady) {
      vditorIsReady = true
      resolveVditorReady()
      resolveVditorReady = null
    }
  },
  input(value) {
    onWysiwygInput(value)
  }
})

/**
 * 超过这个字符数就不做所见即所得渲染。
 *
 * Vditor 没有虚拟滚动，是整篇文档一次性建成 DOM；几十万字符的文档会建出
 * 海量节点，主线程直接卡死。CodeMirror 有视口渲染，大文件反而没问题，
 * 所以超大文件退回「只用源码面板编辑」。
 */
const WYSIWYG_MAX_CHARS = 300000

let wysiwygDisabled = false

function setWysiwygDisabled(disabled, reason) {
  wysiwygDisabled = disabled
  els.wysiwyg.hidden = disabled
  els.wysiwygNotice.hidden = !disabled
  if (disabled) els.wysiwygNotice.textContent = reason
}

/**
 * 把 markdown 送进左侧所见即所得面板。
 * 文件过大时改为提示，不渲染 —— 见 WYSIWYG_MAX_CHARS 的说明。
 */
async function syncToWysiwyg(value, clearStack) {
  if (value.length > WYSIWYG_MAX_CHARS) {
    setWysiwygDisabled(
      true,
      `这个文件约 ${Math.round(value.length / 1024)} KB，已关闭所见即所得渲染以保证流畅。` +
        '请在右侧「源码」面板编辑。'
    )
    // 清空，避免左侧残留上一个文件的内容
    state.syncing = true
    await vditorReady
    vditor.setValue('', true)
    state.syncing = false
    return
  }

  setWysiwygDisabled(false)
  state.syncing = true
  await vditorReady
  vditor.setValue(value, clearStack)
  state.syncing = false
}

/** Vditor 每次输入都会带着完整 markdown 调这里 */
function onWysiwygInput(value) {
  if (state.syncing) return

  const tab = activeTab()
  if (!tab) return

  // 立即同步到源码面板，保证 doc 始终是最新内容（内部是局部替换，不是全量重建）
  state.syncing = true
  applyToSource(value)
  state.syncing = false

  refreshDirty(tab, value)
  scheduleAutosave()
}

/**
 * 触发一个工具栏动作。
 * 优先用 Vditor 内部的元素表（它自己的 hotkey 就是这么派发的：`elements[name].children[0]`），
 * 拿不到就退回按 data-type 查 DOM。
 */
function clickToolbar(name) {
  const elements = vditor.vditor && vditor.vditor.toolbar && vditor.vditor.toolbar.elements
  const holder = elements && elements[name]
  const button = holder
    ? holder.children[0]
    : document.querySelector(`#wysiwyg .vditor-toolbar [data-type="${name}"]`)

  if (button) button.click()
}

/**
 * 左侧的快捷键。
 *
 * ⌘1~⌘6 设标题：Vditor 把等价功能硬编码在 ⌥⌘1~⌥⌘6 上（内部走 `It(vditor, "## ")`，
 * 和工具栏标题按钮同一条路径）。与其去调它的内部函数，不如拦下 ⌘N 再派发一个
 * altKey=true 的同键事件，让它自己的成熟逻辑处理。派发出去的事件带 altKey，
 * 不会再命中这个分支，不会递归。
 *
 * ⌘⇧K 插代码块：Vditor 的 `code` / `inline-code` 工具栏项没有绑定任何快捷键
 * （我核对过它的 hotkey 表），所以这里补一个。用 ⌘⇧K 而不是 MarkText 的 ⌥⌘C，
 * 是因为 ⌥⌘C 是 Edge 的「检查元素」，属于浏览器级快捷键，页面拦不住。
 */
els.wysiwyg.addEventListener(
  'keydown',
  (e) => {
    if (!(e.metaKey || e.ctrlKey)) return

    if (!e.altKey && !e.shiftKey && /^Digit[1-6]$/.test(e.code)) {
      e.preventDefault()
      e.stopPropagation()
      e.target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: e.key,
          code: e.code,
          altKey: true,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          bubbles: true,
          cancelable: true
        })
      )
      return
    }

    if (e.shiftKey && !e.altKey && e.code === 'KeyK') {
      e.preventDefault()
      e.stopPropagation()
      clickToolbar('code')
    }
  },
  true
)

// ---------------------------------------------------------------- 偏好设置

/** 这些是纯界面偏好，放 localStorage 就够，不必占用服务端配置 */
const PREF_KEYS = { theme: 'edgemark.theme', autosave: 'edgemark.autosave' }

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式下可能写不了，忽略 */
  }
}

// ---------------------------------------------------------------- 主题

let vditorIsReady = false
let currentTheme = 'light'

function applyTheme(theme) {
  currentTheme = theme === 'dark' ? 'dark' : 'light'
  const dark = currentTheme === 'dark'

  document.documentElement.dataset.theme = currentTheme
  $('#css-markdown').href = dark ? '/vendor/github-markdown-dark.css' : '/vendor/github-markdown-light.css'
  $('#css-prism').href = dark ? '/vendor/prism/themes/prism-tomorrow.css' : '/vendor/prism/themes/prism.css'
  $('#css-cm-theme').href = dark ? '/vendor/codemirror/theme/dracula.css' : '/vendor/codemirror/theme/eclipse.css'

  sourceEditor.setOption('theme', dark ? 'dracula' : 'eclipse')
  // Vditor 在资源加载完之前不能切主题
  if (vditorIsReady) vditor.setTheme(dark ? 'dark' : 'classic')

  els.menuTheme.classList.toggle('is-on', dark)
  els.menuTheme.textContent = dark ? '浅色主题' : '深色主题'
  writePref(PREF_KEYS.theme, currentTheme)
}

// ---------------------------------------------------------------- 页面地址

/**
 * 让页面 URL 跟着当前文件走（例如 /sub/notes.md）。
 *
 * 这不是为了好看 —— 是本地图片能显示的关键：markdown 里的相对图片路径
 * `images/a.png` 会被浏览器按当前地址解析成 `/sub/images/a.png`，
 * 服务端再从根目录把这张图发出来。这样就不必去改 DOM 里的 img src，
 * 而 Vditor 的 getValue() 是从 innerHTML 反推 markdown 的，
 * 改 src 会被写回文档、污染用户的文件。
 */
function syncPageUrl() {
  const tab = activeTab()
  const target = tab ? `/${tab.path.split('/').map(encodeURIComponent).join('/')}` : '/'
  if (location.pathname !== target) {
    history.replaceState(null, '', target)
  }
}

// ---------------------------------------------------------------- 自动保存

let autosaveEnabled = readPref(PREF_KEYS.autosave, '0') === '1'
let autosaveTimer = null

function setAutosave(enabled) {
  autosaveEnabled = enabled
  writePref(PREF_KEYS.autosave, enabled ? '1' : '0')
  els.menuAutosave.classList.toggle('is-on', enabled)
  if (!enabled) clearTimeout(autosaveTimer)
}

function scheduleAutosave() {
  if (!autosaveEnabled) return
  clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => {
    const tab = activeTab()
    if (tab && tab.dirty && !ai.streaming) save({ silent: true })
  }, 1200)
}

// ---------------------------------------------------------------- 外部改动监听

/**
 * 已打开的文件在磁盘上被别的程序改动时，服务端会推过来。
 * 标签是干净的 → 自动重载；有未保存改动 → 提示冲突，**不静默覆盖**。
 */
function connectWatcher() {
  const source = new EventSource('/api/watch')

  source.addEventListener('message', async (e) => {
    let payload
    try {
      payload = JSON.parse(e.data)
    } catch {
      return
    }

    const tab = state.tabs.find((t) => t.path === payload.path)
    if (!tab) return
    // 自己刚保存触发的改动，忽略
    if (Date.now() - tab.lastSavedAt < 1500) return

    if (tab.dirty) {
      setStatus(`「${tab.name}」在磁盘上被外部修改了，你有未保存的改动`, 'dirty')
      return
    }

    try {
      const file = await api.get('/api/file', { path: tab.path })
      if (file.content === tab.doc.getValue()) return

      state.syncing = true
      tab.doc.setValue(file.content)
      state.syncing = false

      if (tab.id === state.activeId) await syncToWysiwyg(file.content, false)
      setStatus(`「${tab.name}」已在磁盘上更新，已重新载入`)
    } catch (err) {
      setStatus(`重新载入失败：${err.message}`)
    }
  })

  // EventSource 会自己重连，这里只提示一下
  source.addEventListener('error', () => {
    if (source.readyState === EventSource.CLOSED) setStatus('与服务端的连接已断开')
  })
}

let watchSyncTimer = null

/** 标签增删时同步监视清单，防抖避免频繁请求 */
function scheduleWatchSync() {
  clearTimeout(watchSyncTimer)
  watchSyncTimer = setTimeout(syncWatchList, 300)
}

/** 把当前打开的标签同步给服务端，只监视这些文件 */
function syncWatchList() {
  api.post('/api/watch', { paths: state.tabs.map((t) => t.path) }).catch(() => {})
}

// ---------------------------------------------------------------- 导出

function exportHtml() {
  const tab = activeTab()
  if (!tab) return

  const body = md.render(tab.doc.getValue())
  const dark = currentTheme === 'dark'
  const styleHref = dark ? '/vendor/github-markdown-dark.css' : '/vendor/github-markdown-light.css'

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(tab.name)}</title>
<link rel="stylesheet" href="${styleHref}">
<style>
  body { margin: 0; background: ${dark ? '#0d1117' : '#fff'}; }
  .markdown-body { box-sizing: border-box; max-width: 900px; margin: 0 auto; padding: 40px 24px 80px; }
</style>
</head>
<body class="markdown-body">
${body}
</body>
</html>`

  downloadBlob(html, `${stripExt(tab.name)}.html`, 'text/html;charset=utf-8')
}

function exportPdf() {
  const tab = activeTab()
  if (!tab) return

  // 直接 window.print() 会把工具栏、目录树一起打进去，
  // 所以先把渲染结果放进一个只用于打印的容器，打印期间把其它元素藏起来。
  let holder = document.getElementById('print-holder')
  if (!holder) {
    holder = document.createElement('div')
    holder.id = 'print-holder'
    holder.className = 'markdown-body'
    document.body.appendChild(holder)
  }
  holder.innerHTML = md.render(tab.doc.getValue())

  // 深色样式打出来是一片黑底，打印时临时换回浅色
  const wasDark = currentTheme === 'dark'
  if (wasDark) $('#css-markdown').href = '/vendor/github-markdown-light.css'

  document.body.classList.add('is-printing')
  setStatus('在打印对话框里选择「另存为 PDF」')
  window.print()

  document.body.classList.remove('is-printing')
  holder.innerHTML = ''
  if (wasDark) $('#css-markdown').href = '/vendor/github-markdown-dark.css'
}

function downloadBlob(text, filename, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// ---------------------------------------------------------------- 下拉菜单

const openMenus = new Set()

function setMenu(panel, open) {
  panel.hidden = !open
  if (open) openMenus.add(panel)
  else openMenus.delete(panel)
}

function closeAllMenus() {
  for (const panel of [...openMenus]) setMenu(panel, false)
}

function toggleMenu(panel) {
  const willOpen = panel.hidden
  closeAllMenus()
  setMenu(panel, willOpen)
}

document.addEventListener('click', (e) => {
  // 点在菜单内部不关；点其他地方一律关掉
  for (const panel of openMenus) {
    if (panel.contains(e.target)) return
  }
  if (e.target.closest('#btn-more, #btn-tab-list')) return
  closeAllMenus()
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllMenus()
})

els.btnMore.addEventListener('click', (e) => {
  e.stopPropagation()
  toggleMenu(els.moreMenu)
})

els.menuTheme.addEventListener('click', () => {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark')
  closeAllMenus()
})

els.menuAutosave.addEventListener('click', () => {
  setAutosave(!autosaveEnabled)
  closeAllMenus()
})

els.menuExportHtml.addEventListener('click', () => {
  closeAllMenus()
  exportHtml()
})

els.menuExportPdf.addEventListener('click', () => {
  closeAllMenus()
  exportPdf()
})

// ---------------------------------------------------------------- 状态显示

function setStatus(text, kind) {
  els.status.textContent = text || ''
  els.status.classList.toggle('status--dirty', kind === 'dirty')
}

function updateSaveButton() {
  const tab = activeTab()
  els.btnSave.disabled = !tab || !tab.dirty
}

function refreshDirty(tab, value) {
  const dirty = value !== tab.savedContent
  if (dirty === tab.dirty) return
  tab.dirty = dirty
  renderTabs()
  updateSaveButton()
  setStatus(dirty ? '有未保存的修改' : '已保存', dirty ? 'dirty' : '')
}

// ---------------------------------------------------------------- 标签栏

function renderTabs() {
  els.tabs.innerHTML = ''

  for (const tab of state.tabs) {
    const el = document.createElement('div')
    el.className = tab.id === state.activeId ? 'tab is-active' : 'tab'
    el.title = tab.path

    const dot = document.createElement('span')
    dot.className = tab.dirty ? 'tab__dot is-dirty' : 'tab__dot'
    el.appendChild(dot)

    const name = document.createElement('span')
    name.className = 'tab__name'
    name.textContent = tab.name
    el.appendChild(name)

    const close = document.createElement('span')
    close.className = 'tab__close'
    close.textContent = '\u00d7' // ×
    close.title = '关闭'
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      closeTab(tab.id)
    })
    el.appendChild(close)

    el.addEventListener('click', () => activateTab(tab.id))
    // 鼠标中键关闭，和浏览器一致
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault()
        closeTab(tab.id)
      }
    })

    els.tabs.appendChild(el)

    if (tab.id === state.activeId) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }

  els.tabbar.classList.toggle('is-empty', state.tabs.length === 0)
  scheduleWatchSync()
  updateTabOverflow()
}

async function activateTab(id) {
  const tab = state.tabs.find((t) => t.id === id)
  if (!tab || tab.id === state.activeId) return

  // 切走了，之前排队的同步不能再落到新标签上
  clearTimeout(sourceSyncTimer)

  state.activeId = id
  state.syncing = true
  sourceEditor.swapDoc(tab.doc)
  state.syncing = false

  // clearStack：换文件时不要沿用上一个文件的撤销历史
  await syncToWysiwyg(tab.doc.getValue(), true)

  els.currentPath.textContent = tab.path
  highlightActive(tab.path)
  renderTabs()
  updateSaveButton()
  setStatus(tab.dirty ? '有未保存的修改' : '已保存', tab.dirty ? 'dirty' : '')

  // 页面地址跟着文件走，这样 markdown 里的相对图片路径才能被解析到正确位置
  syncPageUrl()
  // 每个文件一套独立的对话
  switchAiHistory(tab.path)
}

function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id)
  if (idx === -1) return

  const tab = state.tabs[idx]
  if (tab.dirty && !confirm(`「${tab.name}」有未保存的修改，确定关闭吗？`)) return

  state.tabs.splice(idx, 1)

  if (state.activeId !== id) {
    renderTabs()
    return
  }

  state.activeId = null
  const next = state.tabs[idx] || state.tabs[idx - 1]
  if (next) activateTab(next.id)
  else showEmptyState()
}

function closeAllTabs() {
  state.tabs = []
  state.activeId = null
  showEmptyState()
}

async function showEmptyState() {
  state.activeId = null
  clearTimeout(sourceSyncTimer)

  state.syncing = true
  // 每次都换一份干净的空文档，避免残留上一次的临时内容
  state.scratchDoc = window.CodeMirror.Doc('', 'gfm')
  sourceEditor.swapDoc(state.scratchDoc)
  state.syncing = false

  await syncToWysiwyg('', true)

  els.currentPath.textContent = '未打开文件'
  highlightActive(null)
  renderTabs()
  updateSaveButton()
  setStatus('')

  syncPageUrl()
  switchAiHistory(null)
}

// ---------------------------------------------------------------- 目录树

/** 已展开的目录，重渲染后用来恢复展开状态 */
const expandedDirs = new Set()

/** 新建的目标目录：跟随最后点选的目录（或最后打开文件所在的目录） */
let selectedDir = '.'

const baseName = (p) => p.split('/').pop()
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.')
const joinPath = (dir, name) => (dir && dir !== '.' ? `${dir}/${name}` : name)
const stripExt = (name) => name.replace(/\.[^.]+$/, '')

async function loadTree() {
  els.tree.innerHTML = ''
  try {
    await renderDir('.', els.tree, 0)
  } catch (err) {
    els.tree.innerHTML = ''
    els.tree.appendChild(hint(`读取目录失败：${err.message}`, 'tree__error'))
  }
}

function hint(text, cls) {
  const div = document.createElement('div')
  div.className = cls
  div.textContent = text
  return div
}

const ICON_RENAME = 'M11.6 2.4l2 2L5.2 12.8l-2.7.7.7-2.7z'
const ICON_DELETE = 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6'

function iconButton(title, pathD) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'icon-btn'
  btn.title = title
  btn.innerHTML =
    '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">' +
    `<path d="${pathD}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`
  return btn
}

async function renderDir(dirPath, container, depth) {
  const data = await api.get('/api/tree', { dir: dirPath })

  if (!data.entries.length) {
    container.appendChild(hint('（空）', 'tree__empty'))
    return
  }

  for (const entry of data.entries) {
    const { row, expand } = createRow(entry, depth)
    container.appendChild(row)
    // 恢复重渲染之前的展开状态
    if (expand && expandedDirs.has(entry.path)) await expand(true)
  }
}

function createRow(entry, depth) {
  const row = document.createElement('div')
  row.className = 'tree__row'
  row.dataset.path = entry.path
  row.style.paddingLeft = `${8 + depth * 14}px`
  if (entry.type === 'file') row.dataset.filePath = entry.path
  // 可拖拽：拖到别的目录上就是移动
  row.draggable = true

  const arrow = document.createElement('span')
  arrow.className = 'tree__arrow'
  row.appendChild(arrow)

  const icon = document.createElement('span')
  icon.className = `tree__icon tree__icon--${entry.type}`
  row.appendChild(icon)

  const name = document.createElement('span')
  name.className = 'tree__name'
  name.textContent = entry.name
  row.appendChild(name)

  const actions = document.createElement('span')
  actions.className = 'tree__actions'
  const renameBtn = iconButton('重命名', ICON_RENAME)
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    renameEntry(entry)
  })
  const deleteBtn = iconButton('删除（移入废纸篓）', ICON_DELETE)
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    deleteEntry(entry)
  })
  actions.append(renameBtn, deleteBtn)
  row.appendChild(actions)

  if (entry.type !== 'dir') {
    row.addEventListener('click', () => openFile(entry))
    return { row }
  }

  arrow.textContent = '\u25B8' // ▸
  let childBox = null

  const expand = async (open) => {
    if (!open) {
      arrow.classList.remove('is-open')
      if (childBox) childBox.hidden = true
      expandedDirs.delete(entry.path)
      return
    }

    arrow.classList.add('is-open')
    if (!childBox) {
      childBox = document.createElement('div')
      row.after(childBox)
      try {
        await renderDir(entry.path, childBox, depth + 1)
      } catch (err) {
        childBox.appendChild(hint(`读取失败：${err.message}`, 'tree__error'))
      }
    }
    childBox.hidden = false
    expandedDirs.add(entry.path)
  }

  row.addEventListener('click', () => {
    selectDir(entry.path)
    expand(!arrow.classList.contains('is-open'))
  })

  return { row, expand }
}

function selectDir(dirPath) {
  selectedDir = dirPath
  for (const el of els.tree.querySelectorAll('.tree__row.is-selected')) {
    el.classList.remove('is-selected')
  }
  const target = els.tree.querySelector(`.tree__row[data-path="${CSS.escape(dirPath)}"]`)
  if (target) target.classList.add('is-selected')
}

function highlightActive(path) {
  for (const el of els.tree.querySelectorAll('.tree__row.is-active')) {
    el.classList.remove('is-active')
  }
  if (!path) return
  const target = els.tree.querySelector(`.tree__row[data-file-path="${CSS.escape(path)}"]`)
  if (target) target.classList.add('is-active')
}

// ---------------------------------------------------------------- 名称输入框

let nameDialogResolve = null

function askName({ title, hint: hintText, value = '', error = '', confirmText = '确定' }) {
  return new Promise((resolve) => {
    els.nameTitle.textContent = title
    els.nameHint.textContent = hintText || ''
    els.nameInput.value = value
    els.nameError.textContent = error
    els.nameForm.querySelector('button[type="submit"]').textContent = confirmText

    nameDialogResolve = resolve
    els.nameDialog.showModal()
    els.nameInput.focus()

    // 选中主文件名（不含扩展名），方便直接改名
    const dot = value.lastIndexOf('.')
    els.nameInput.setSelectionRange(0, dot > 0 ? dot : value.length)
  })
}

function closeNameDialog(result) {
  const resolve = nameDialogResolve
  nameDialogResolve = null
  els.nameDialog.close()
  if (resolve) resolve(result)
}

els.nameForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const value = els.nameInput.value.trim()
  if (!value) {
    els.nameError.textContent = '名称不能为空'
    return
  }
  if (value.includes('/')) {
    els.nameError.textContent = '名称里不能包含「/」'
    return
  }
  closeNameDialog(value)
})

els.nameCancel.addEventListener('click', () => closeNameDialog(null))

// 按 ESC 关闭也要 resolve，否则这个 Promise 会一直挂着
els.nameDialog.addEventListener('close', () => {
  if (!nameDialogResolve) return
  const resolve = nameDialogResolve
  nameDialogResolve = null
  resolve(null)
})

/**
 * 反复询问名称直到操作成功或用户取消。
 * 失败时把错误显示在同一个对话框里并保留输入，不用重新输一遍。
 */
async function askNameUntilOk(options, action) {
  let current = options
  for (;;) {
    const name = await askName(current)
    if (name === null) return null

    try {
      await action(name)
      return name
    } catch (err) {
      current = { ...options, value: name, error: err.message }
    }
  }
}

// ---------------------------------------------------------------- 文件操作

async function createFile() {
  const dir = selectedDir
  const where = dir === '.' ? '根目录' : dir

  await askNameUntilOk(
    { title: '新建文件', hint: `位置：${where}`, value: '未命名.md', confirmText: '创建' },
    async (name) => {
      const res = await api.post('/api/file', {
        path: joinPath(dir, name),
        content: `# ${stripExt(name)}\n\n`
      })
      await loadTree()
      selectDir(dir)
      await openFile({ path: res.path, name: baseName(res.path), type: 'file' })
    }
  )
}

async function createDir() {
  const dir = selectedDir
  const where = dir === '.' ? '根目录' : dir

  await askNameUntilOk(
    { title: '新建文件夹', hint: `位置：${where}`, value: '新建文件夹', confirmText: '创建' },
    async (name) => {
      await api.post('/api/dir', { path: joinPath(dir, name) })
      await loadTree()
      selectDir(dir)
    }
  )
}

async function renameEntry(entry) {
  const dir = dirName(entry.path)
  const oldName = baseName(entry.path)
  const where = dir === '.' ? '根目录' : dir

  await askNameUntilOk(
    {
      title: entry.type === 'dir' ? '重命名文件夹' : '重命名文件',
      hint: `位置：${where}`,
      value: oldName,
      confirmText: '重命名'
    },
    async (name) => {
      if (name === oldName) return
      const res = await api.post('/api/rename', { path: entry.path, to: joinPath(dir, name) })
      afterPathChange(res.from, res.to)
    }
  )
}

async function deleteEntry(entry) {
  const what = entry.type === 'dir' ? '文件夹' : '文件'
  const extra = entry.type === 'dir' ? '（连同里面的全部内容）' : ''

  const ok = confirm(`把${what}「${entry.name}」${extra}移入废纸篓？\n\n不会永久删除，可以在访达的废纸篓里找回。`)
  if (!ok) return

  try {
    await api.del('/api/entry', { path: entry.path })
    afterPathRemoved(entry.path)
  } catch (err) {
    alert(`删除失败：${err.message}`)
  }
}

/** 路径被重命名/移动后，同步已打开的标签与当前目录 */
function afterPathChange(from, to) {
  for (const tab of state.tabs) {
    if (tab.path === from) {
      tab.path = to
      tab.name = baseName(to)
    } else if (tab.path.startsWith(from + '/')) {
      tab.path = to + tab.path.slice(from.length)
    }
  }

  if (selectedDir === from) selectedDir = to
  else if (selectedDir.startsWith(from + '/')) selectedDir = to + selectedDir.slice(from.length)

  const active = activeTab()
  if (active) {
    els.currentPath.textContent = active.path
    renderTabs()
  }

  // 重渲染后展开到改动的位置
  if (from.includes('/')) expandedDirs.add(dirName(from))
  loadTree().then(() => {
    if (active) highlightActive(active.path)
  })
}

/** 路径被删除后，关掉受影响的标签 */
function afterPathRemoved(path) {
  const affected = state.tabs.filter((t) => t.path === path || t.path.startsWith(path + '/'))
  // closeTab 内部会对有未保存修改的标签再确认一次
  for (const tab of affected) closeTab(tab.id)

  if (selectedDir === path || selectedDir.startsWith(path + '/')) {
    selectedDir = '.'
  }

  if (path.includes('/')) expandedDirs.add(dirName(path))
  loadTree()
}

els.btnNewFile.addEventListener('click', createFile)
els.btnNewDir.addEventListener('click', createDir)
els.btnRefreshTree.addEventListener('click', () => loadTree())

// ---------------------------------------------------------------- 打开 / 保存

async function openFile(entry) {
  // 已经开着就直接切过去
  const existing = state.tabs.find((t) => t.path === entry.path)
  if (existing) {
    activateTab(existing.id)
    return
  }

  // 新建时默认放到当前文件所在的目录
  selectedDir = dirName(entry.path)

  try {
    const file = await api.get('/api/file', { path: entry.path })

    state.tabs.push({
      id: ++tabSeq,
      path: file.path,
      name: file.name,
      doc: window.CodeMirror.Doc(file.content, 'gfm'),
      savedContent: file.content,
      dirty: false,
      /** 最近一次落盘时间，用来忽略「自己保存」触发的文件变化通知 */
      lastSavedAt: 0
    })

    await activateTab(state.tabs[state.tabs.length - 1].id)
  } catch (err) {
    setStatus(`打开失败：${err.message}`)
  }
}

async function save({ silent = false } = {}) {
  const tab = activeTab()
  if (!tab) return

  // doc 是内容真源，Vditor 的改动会立即写进来
  const content = tab.doc.getValue()
  if (!silent) setStatus('保存中…')
  try {
    await api.put('/api/file', { path: tab.path, content })
    tab.savedContent = content
    tab.dirty = false
    tab.lastSavedAt = Date.now()
    renderTabs()
    updateSaveButton()
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    setStatus(`${silent ? '已自动保存' : '已保存'} ${time}`)
  } catch (err) {
    setStatus(`保存失败：${err.message}`)
  }
}

els.btnSave.addEventListener('click', save)

/**
 * 保存快捷键。挂在 window 的捕获阶段，这样不管焦点在左侧 Vditor、
 * 右侧源码面板还是别处都能生效，并且 preventDefault 掉浏览器默认的「保存网页」。
 */
window.addEventListener(
  'keydown',
  (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
    if (e.code !== 'KeyS' && e.key.toLowerCase() !== 's') return
    e.preventDefault()
    save()
  },
  true
)

window.addEventListener('beforeunload', (e) => {
  if (!state.tabs.some((t) => t.dirty)) return
  e.preventDefault()
  e.returnValue = ''
})

// ---------------------------------------------------------------- 右侧面板切换

function showRightPane(which) {
  const isAi = which === 'ai'
  // 注意：要隐藏的是 CodeMirror 的包裹元素，原来的 <textarea> 已经被它替换掉了
  sourceWrapper.hidden = isAi
  els.aiPanel.hidden = !isAi
  els.ptabSource.classList.toggle('is-active', !isAi)
  els.ptabAi.classList.toggle('is-active', isAi)

  if (isAi) {
    renderAiMessages()
    els.aiInput.focus()
  } else {
    // 之前是 display:none，CodeMirror 量不到尺寸，切回来必须重算
    sourceEditor.refresh()
  }
}

els.ptabSource.addEventListener('click', () => showRightPane('source'))
els.ptabAi.addEventListener('click', () => showRightPane('ai'))

// ---------------------------------------------------------------- AI 助手

const AI_SYSTEM_PROMPT = [
  '你是一个 Markdown 文档助手。用户会就一份 Markdown 文件向你提问。',
  '请只依据我提供的文件内容作答；文件里没有提到的信息，明确说「文档里没有提到」，不要编造。',
  '用简体中文回答，简洁直接，必要时引用原文片段。',
  '',
  '当用户要求你修改这份文档时，除了说明思路，还必须输出可执行的修改块。格式严格如下：',
  '',
  '<<<<<<< SEARCH',
  '（要被替换的原文）',
  '=======',
  '（替换后的内容）',
  '>>>>>>> REPLACE',
  '',
  '修改块的规则：',
  '1. 一个块只改一处，可以连续输出多个块。',
  '2. SEARCH 里的内容必须与文档中**逐字符一致**（包括缩进、标点、空行），否则无法应用。',
  '3. SEARCH 必须在文档里**唯一匹配**。所以请带上足够的上下文（通常前后各留 1~2 行），不要只写一个短句。',
  '4. 只输出需要改动的片段，**不要输出整个文件**。',
  '5. 留空 REPLACE 表示删除这段内容。',
  '6. 修改块统一放在回答的最末尾。',
  '7. 如果只是回答问题、不需要改动文档，就**不要输出任何修改块**。'
].join('\n')

/**
 * 把「编辑块」从正文里剥掉，只留给人看的说明。
 *
 * 流式输出时块还没收完，所以这里按「第一个 SEARCH 标记之后全部丢掉」来处理
 * —— 系统提示词要求修改块统一放在最后，所以这样切是安全的，
 * 也能避免气泡里闪出一堆 `<<<<<<<` 标记。
 */
function stripEditBlocks(text) {
  const idx = text.search(/^[ \t]*<{7}[ \t]*SEARCH[ \t]*$/m)
  return (idx === -1 ? text : text.slice(0, idx)).trim()
}

const isSearchLine = (l) => /^[ \t]*<{7}[ \t]*SEARCH[ \t]*$/.test(l)
const isSepLine = (l) => /^[ \t]*={7}[ \t]*$/.test(l)
const isReplaceLine = (l) => /^[ \t]*>{7}[ \t]*REPLACE[ \t]*$/.test(l)

/**
 * 解析回答里的编辑块。格式不完整的块会被当作普通正文保留，不会静默吞掉内容。
 */
function parseEdits(raw) {
  const lines = raw.split('\n')
  const edits = []
  const plain = []
  let i = 0

  while (i < lines.length) {
    if (!isSearchLine(lines[i])) {
      plain.push(lines[i++])
      continue
    }

    // 先确认这个块是完整的，不完整就按普通文本处理
    let j = i + 1
    const search = []
    while (j < lines.length && !isSepLine(lines[j])) search.push(lines[j++])
    if (j >= lines.length) {
      plain.push(lines[i++])
      continue
    }
    j++
    const replace = []
    while (j < lines.length && !isReplaceLine(lines[j])) replace.push(lines[j++])
    if (j >= lines.length) {
      plain.push(lines[i++])
      continue
    }
    j++

    edits.push({ search: search.join('\n'), replace: replace.join('\n') })
    i = j
  }

  return { edits, text: plain.join('\n').replace(/\n{3,}/g, '\n\n').trim() }
}

/** 在 content 里定位 search，返回 [start, end)；找不到或有歧义返回 null */
function locate(content, search) {
  const first = content.indexOf(search)
  if (first === -1) return null
  if (content.indexOf(search, first + 1) !== -1) return { ambiguous: true }
  return { start: first, end: first + search.length }
}

/**
 * 逐行比对定位（忽略行尾空白）。
 * 模型最常见的偏差就是多/少几个行尾空格，精确匹配失败时用它兜底。
 */
function locateTolerant(content, search) {
  const contentLines = content.split('\n')
  const searchLines = search.split('\n').map((l) => l.replace(/\s+$/, ''))
  if (searchLines.length > contentLines.length) return null

  // 每行在 content 中的起始下标
  const offsets = []
  let pos = 0
  for (const line of contentLines) {
    offsets.push(pos)
    pos += line.length + 1
  }

  const hits = []
  for (let i = 0; i + searchLines.length <= contentLines.length; i++) {
    let same = true
    for (let k = 0; k < searchLines.length; k++) {
      if (contentLines[i + k].replace(/\s+$/, '') !== searchLines[k]) {
        same = false
        break
      }
    }
    if (same) {
      hits.push(i)
      if (hits.length > 1) return { ambiguous: true }
    }
  }

  if (!hits.length) return null
  const startLine = hits[0]
  const endLine = startLine + searchLines.length
  return { start: offsets[startLine], end: endLine < contentLines.length ? offsets[endLine] - 1 : content.length }
}

/**
 * 把一组修改应用到 content 上。
 * 逐处独立处理，某处失败不影响其他处，失败原因会带回给用户。
 */
function applyEdits(content, edits) {
  let out = content
  const results = []

  for (const edit of edits) {
    if (!edit.search) {
      results.push({ edit, ok: false, reason: 'SEARCH 段是空的' })
      continue
    }

    let range = locate(out, edit.search)
    let exact = true
    if (!range) {
      range = locateTolerant(out, edit.search)
      exact = false
    }

    if (!range) {
      results.push({ edit, ok: false, reason: '在文档里找不到这段原文' })
      continue
    }
    if (range.ambiguous) {
      results.push({ edit, ok: false, reason: '这段原文在文档里出现多次，无法确定改哪一处' })
      continue
    }

    out = out.slice(0, range.start) + edit.replace + out.slice(range.end)
    results.push({ edit, ok: true, exact })
  }

  return { content: out, results }
}

/** 行级差异，只用于展示：掐掉首尾相同的行，中间标成删除/新增 */
function lineDiff(before, after) {
  const la = before.split('\n')
  const lb = after.split('\n')

  let start = 0
  while (start < la.length && start < lb.length && la[start] === lb[start]) start++

  let ea = la.length
  let eb = lb.length
  while (ea > start && eb > start && la[ea - 1] === lb[eb - 1]) {
    ea--
    eb--
  }

  return {
    contextBefore: start > 0 ? la[start - 1] : null,
    removed: la.slice(start, ea),
    added: lb.slice(start, eb),
    contextAfter: ea < la.length ? la[ea] : null
  }
}

/** 单次请求最多带多少字符的文档，避免超出上下文窗口 */
const AI_DOC_LIMIT = 60000

const ai = {
  config: { baseUrl: '', model: '', hasApiKey: false },
  /**
   * 按文件隔离的对话历史：文件路径 → [{ role, content, edits }]。
   * 切标签会换一整套会话，避免「上一条消息用的还是旧文件的上下文」这种困惑。
   */
  histories: new Map(),
  /** 当前正在用的那套（就是 histories 里的某个数组） */
  history: [],
  /** 当前历史对应的文件路径，'' 表示没有打开文件 */
  key: '',
  streaming: false,
  controller: null
}

/** 切换当前对话到某个文件的历史 */
function switchAiHistory(path) {
  const nextKey = path || ''

  // 先把当前这套存回去
  if (ai.key && ai.history.length) ai.histories.set(ai.key, ai.history)

  ai.key = nextKey
  ai.history = ai.histories.get(nextKey) || []
  renderAiMessages()
}

/**
 * 文档内容每次都从当前标签重新取，所以用户边改边问也能反映最新内容。
 * 用显式分隔符而不是代码围栏——文档里本来就可能含 ```，围栏会被截断。
 */
function buildDocMessage() {
  const tab = activeTab()
  if (!tab) return '当前没有打开任何文件。如果用户提问，请先提醒他打开一个文件。'

  const content = tab.doc.getValue()
  const truncated = content.length > AI_DOC_LIMIT
  const body = truncated ? content.slice(0, AI_DOC_LIMIT) : content
  const note = truncated
    ? `\n\n（注意：文件过长，以上只是前 ${AI_DOC_LIMIT} 个字符，全文共 ${content.length} 个字符。）`
    : ''

  return `当前打开的文件：${tab.path}\n\n===== 文件内容开始 =====\n${body}\n===== 文件内容结束 =====${note}`
}

function scrollAiToBottom() {
  els.aiMessages.scrollTop = els.aiMessages.scrollHeight
}

function aiMessageEl(message) {
  const el = document.createElement('div')
  el.className = `ai-msg ai-msg--${message.role}`

  const role = document.createElement('div')
  role.className = 'ai-msg__role'
  role.textContent = message.role === 'user' ? '你' : 'AI'
  el.appendChild(role)

  const body = document.createElement('div')
  body.className = 'ai-msg__body'
  if (message.role === 'assistant') {
    body.classList.add('markdown-body')
    const text = stripEditBlocks(message.content)
    body.innerHTML = text ? md.render(text) : '<span class="ai-hint">思考中…</span>'
  } else {
    body.textContent = message.content
  }
  el.appendChild(body)

  if (message.role === 'assistant' && message.edits && message.edits.length && !message.dismissed) {
    el.appendChild(editsCard(message))
  }

  // 回答里的行内代码能对上原文的，做成可点击的跳转
  if (message.role === 'assistant') linkifyAiCode(body)

  return el
}

/** 「拟修改 N 处」卡片：逐处 diff + 应用/忽略 */
function editsCard(message) {
  const card = document.createElement('div')
  card.className = 'ai-edits'

  // 应用时要基于**当前**的文档内容，所以这里实时重算一遍能不能匹配上
  const tab = activeTab()
  const results = tab ? applyEdits(tab.doc.getValue(), message.edits).results : null
  const applicable = results ? results.filter((r) => r.ok).length : 0

  const head = document.createElement('div')
  head.className = 'ai-edits__head'
  if (message.applied) {
    head.textContent = `已应用 ${message.appliedCount} 处修改（记得保存）`
  } else if (!tab) {
    head.textContent = `拟修改 ${message.edits.length} 处，但没有打开的文件`
  } else {
    head.textContent =
      `拟修改 ${message.edits.length} 处，当前可应用 ${applicable} 处` +
      (applicable < message.edits.length ? '（其余匹配不上，见下方说明）' : '')
  }
  card.appendChild(head)

  const list = document.createElement('div')
  list.className = 'ai-edits__list'

  message.edits.forEach((edit, i) => {
    const r = results && results[i]
    const item = document.createElement('div')
    item.className = r && !r.ok ? 'ai-edit is-failed' : 'ai-edit'

    const label = document.createElement('div')
    label.className = 'ai-edit__label'
    label.textContent = `第 ${i + 1} 处` + (r && !r.ok ? ` — ${r.reason}` : '')
    item.appendChild(label)

    const diff = lineDiff(edit.search, edit.replace)
    const pre = document.createElement('pre')
    pre.className = 'ai-edit__diff'

    const addLine = (cls, text) => {
      const line = document.createElement('span')
      line.className = `ai-edit__line ${cls}`
      line.textContent = text
      pre.appendChild(line)
    }
    if (diff.contextBefore !== null) addLine('is-ctx', `  ${diff.contextBefore}`)
    for (const l of diff.removed) addLine('is-del', `- ${l}`)
    for (const l of diff.added) addLine('is-add', `+ ${l}`)
    if (diff.contextAfter !== null) addLine('is-ctx', `  ${diff.contextAfter}`)

    item.appendChild(pre)
    list.appendChild(item)
  })
  card.appendChild(list)

  if (!message.applied) {
    const actions = document.createElement('div')
    actions.className = 'ai-edits__actions'

    const applyBtn = document.createElement('button')
    applyBtn.type = 'button'
    applyBtn.className = 'btn btn--primary'
    applyBtn.textContent = '应用到当前文件'
    applyBtn.disabled = applicable === 0
    applyBtn.addEventListener('click', () => applyMessageEdits(message))
    actions.appendChild(applyBtn)

    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'btn btn--ghost'
    dismiss.textContent = '忽略'
    dismiss.addEventListener('click', () => {
      message.dismissed = true
      renderAiMessages()
    })
    actions.appendChild(dismiss)

    card.appendChild(actions)
  }

  return card
}

/**
 * 把 AI 提议的修改写进当前文件。
 * 只改内存里的内容并标记为未保存 —— 落盘仍由用户按 ⌘S 决定。
 */
async function applyMessageEdits(message) {
  const tab = activeTab()
  if (!tab) {
    alert('请先在左侧打开一个文件')
    return
  }

  const { content, results } = applyEdits(tab.doc.getValue(), message.edits)
  // 带上原始序号，报错时能对上「第几处」
  const failed = results.map((r, i) => ({ ...r, index: i })).filter((r) => !r.ok)

  if (failed.length === results.length) {
    alert(
      '这些修改都没能应用：\n\n' +
        failed.map((r) => `第 ${r.index + 1} 处：${r.reason}`).join('\n') +
        '\n\n可以让 AI 重新给出更完整的上下文再试。'
    )
    return
  }

  if (failed.length) {
    const lines = failed.map((r) => `第 ${r.index + 1} 处：${r.reason}`).join('\n')
    const rest = results.length - failed.length
    if (!confirm(`${failed.length} 处匹配不上，会跳过：\n\n${lines}\n\n继续应用其余 ${rest} 处？`)) return
  }

  const applied = results.length - failed.length

  state.syncing = true
  applyToSource(content)
  state.syncing = false

  refreshDirty(tab, content)
  await syncToWysiwyg(content, false)

  message.applied = true
  message.appliedCount = applied
  renderAiMessages()

  // 焦点挪到源码面板：Vditor 没有公开的撤销栈 API，我们改不了它的撤销记录，
  // 但源码面板的撤销历史是好的，⌘Z 在这里立刻可用。
  showRightPane('source')
  sourceEditor.focus()
  setStatus(`已应用 ${applied} 处修改，按 ⌘S 保存；⌘Z 可撤销`)
}

function renderAiMessages() {
  els.aiMessages.innerHTML = ''

  if (!ai.history.length) {
    const hint = document.createElement('div')
    hint.className = 'ai-hint'
    hint.innerHTML = ai.config.hasApiKey
      ? '打开一个文件后直接提问即可。<br>我会自动把<b>当前标签页</b>的完整内容一起发给模型。<br><br>' +
        '想让我<b>改文件</b>就直接说，比如「把第二节标题改成…」「删掉最后一段」。' +
        '我会给出改动预览，<b>你确认后才会应用</b>。'
      : '还没有配置 AI。<br>点右上角「设置」，填 <code>Base URL</code>、<code>Model</code>、<code>API Key</code> 三项就能用。'
    els.aiMessages.appendChild(hint)
    return
  }

  for (const message of ai.history) {
    els.aiMessages.appendChild(aiMessageEl(message))
  }
  scrollAiToBottom()
}

/** 流式过程中只更新最后一条气泡，避免每来一个 token 就重建整个列表 */
function updateLastAiMessage() {
  const message = ai.history[ai.history.length - 1]
  if (!message || message.role !== 'assistant') return

  const nodes = els.aiMessages.querySelectorAll('.ai-msg')
  const last = nodes[nodes.length - 1]
  if (!last) return

  const body = last.querySelector('.ai-msg__body')
  if (!body) return

  const text = stripEditBlocks(message.content)
  body.innerHTML = text ? md.render(text) : '<span class="ai-hint">思考中…</span>'
  scrollAiToBottom()
}

function updateAiBusy() {
  els.btnAiSend.textContent = ai.streaming ? '停止' : '发送'
  els.btnAiSend.classList.toggle('btn--danger', ai.streaming)
}

async function sendAiMessage(rawText) {
  const text = rawText.trim()
  if (!text || ai.streaming) return

  if (!ai.config.hasApiKey) {
    els.aiError.textContent = '还没有配置 API Key。'
    openAiSettings()
    return
  }

  ai.history.push({ role: 'user', content: text })
  ai.history.push({ role: 'assistant', content: '' })

  ai.streaming = true
  updateAiBusy()
  renderAiMessages()

  const messages = [
    { role: 'system', content: AI_SYSTEM_PROMPT },
    { role: 'system', content: buildDocMessage() },
    ...ai.history.slice(0, -1) // 末尾那条空的 assistant 占位不发出去
  ]

  ai.controller = new AbortController()

  try {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal: ai.controller.signal
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `请求失败（${res.status}）`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() // 末段可能被截断，留到下一轮

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue

        let event
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }

        if (event.error) throw new Error(event.error)
        if (event.delta) {
          ai.history[ai.history.length - 1].content += event.delta
          updateLastAiMessage()
        }
      }
    }
  } catch (err) {
    const last = ai.history[ai.history.length - 1]
    if (err.name === 'AbortError') {
      if (!last.content) last.content = '（已停止，没有收到内容）'
    } else if (!last.content) {
      last.content = `请求失败：${err.message}`
    } else {
      last.content += `\n\n（中断：${err.message}）`
    }
    updateLastAiMessage()
  } finally {
    ai.streaming = false
    ai.controller = null
    updateAiBusy()

    // 流结束后再解析修改块（流式过程中块是残缺的，解析不了）
    const last = ai.history[ai.history.length - 1]
    if (last && last.role === 'assistant' && last.content) {
      last.edits = parseEdits(last.content).edits
    }

    renderAiMessages()
  }
}

els.aiForm.addEventListener('submit', (e) => {
  e.preventDefault()

  if (ai.streaming) {
    if (ai.controller) ai.controller.abort()
    return
  }

  const text = els.aiInput.value
  els.aiInput.value = ''
  sendAiMessage(text)
})

// Enter 发送，Shift+Enter 换行；中文输入法组词期间不触发
els.aiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    els.aiForm.requestSubmit()
  }
})

els.btnAiClear.addEventListener('click', () => {
  if (ai.history.length && !confirm('清空当前文件的对话？')) return
  ai.history = []
  // 也要从按文件存的表里删掉，否则切走再切回来又冒出来了
  if (ai.key) ai.histories.delete(ai.key)
  renderAiMessages()
})

// ---------------------------------------------------------------- AI 设置

async function loadAiConfig() {
  ai.config = await api.get('/api/ai/config')
  renderAiMessages()
}

function openAiSettings() {
  els.aiBase.value = ai.config.baseUrl || ''
  els.aiModel.value = ai.config.model || ''
  els.aiKey.value = ''
  els.aiKey.placeholder = ai.config.hasApiKey ? '已保存，留空则不修改' : 'sk-...'
  els.aiKeyNote.textContent = ai.config.hasApiKey
    ? '已保存一个密钥。留空表示不修改；要换就直接输入新的。'
    : '还没有保存密钥。'
  els.aiError.textContent = ''
  els.aiError.style.color = ''
  els.aiDialog.showModal()
}

els.btnAiSettings.addEventListener('click', openAiSettings)
els.aiCancel.addEventListener('click', () => els.aiDialog.close())

/** 把设置表单的当前内容组装成请求体；密钥留空表示不动 */
function settingsPayload() {
  const payload = {
    baseUrl: els.aiBase.value.trim(),
    model: els.aiModel.value.trim()
  }
  const key = els.aiKey.value.trim()
  if (key) payload.apiKey = key
  return payload
}

els.aiFormSettings.addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    ai.config = await api.post('/api/ai/config', settingsPayload())
    els.aiDialog.close()
    renderAiMessages()
    setStatus('AI 设置已保存')
  } catch (err) {
    els.aiError.style.color = ''
    els.aiError.textContent = err.message
  }
})

els.btnAiKeyClear.addEventListener('click', async () => {
  try {
    ai.config = await api.post('/api/ai/config', { apiKey: '' })
    els.aiKey.value = ''
    els.aiKey.placeholder = 'sk-...'
    els.aiKeyNote.textContent = '密钥已清除。'
    renderAiMessages()
  } catch (err) {
    els.aiError.textContent = err.message
  }
})

els.btnAiTest.addEventListener('click', async () => {
  els.aiError.style.color = ''
  els.aiError.textContent = ''
  els.btnAiTest.disabled = true
  els.btnAiTest.textContent = '测试中…'

  try {
    // 先把表单里的值存下来再测，否则测的是上一次的配置
    ai.config = await api.post('/api/ai/config', settingsPayload())
    els.aiKey.value = ''
    els.aiKeyNote.textContent = '已保存一个密钥。留空表示不修改；要换就直接输入新的。'

    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '只回复两个字：正常' }] })
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || `HTTP ${res.status}`)
    }

    // 能读到第一个分片就说明链路通了
    const reader = res.body.getReader()
    const { value } = await reader.read()
    await reader.cancel()
    const text = value ? new TextDecoder().decode(value) : ''

    if (text.includes('"delta"')) {
      els.aiError.style.color = '#1a7f37'
      els.aiError.textContent = '连接正常，配置已保存。'
    } else {
      els.aiError.textContent = '链路通了，但没收到预期内容，请检查 Model 名是否正确。'
    }
  } catch (err) {
    els.aiError.style.color = ''
    els.aiError.textContent = `测试失败：${err.message}`
  } finally {
    els.btnAiTest.disabled = false
    els.btnAiTest.textContent = '测试连接'
    renderAiMessages()
  }
})

// ---------------------------------------------------------------- 根目录对话框

async function loadConfig() {
  const cfg = await api.get('/api/config')
  state.root = cfg.root
  els.rootLabel.textContent = cfg.root
  els.rootLabel.title = cfg.root

  els.rootShortcuts.innerHTML = ''
  for (const s of cfg.shortcuts) {
    els.rootShortcuts.appendChild(chip(s.label, s.path, s.path))
  }

  els.rootRecent.innerHTML = ''
  for (const r of cfg.recentRoots) {
    els.rootRecent.appendChild(chip(null, r, r, 'chip--path'))
  }

  await loadTree()
}

function chip(label, value, title, extraClass) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = extraClass ? `chip ${extraClass}` : 'chip'
  el.textContent = label || value
  el.title = title || value
  el.addEventListener('click', () => {
    els.rootInput.value = value
    els.rootError.textContent = ''
  })
  return el
}

els.btnRoot.addEventListener('click', () => {
  els.rootInput.value = state.root || ''
  els.rootError.textContent = ''
  els.dialog.showModal()
})

els.rootForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const target = els.rootInput.value.trim()
  if (!target) {
    els.rootError.textContent = '请输入目录路径'
    return
  }

  try {
    const cfg = await api.post('/api/config/root', { root: target })
    state.root = cfg.root
    els.rootLabel.textContent = cfg.root
    els.rootLabel.title = cfg.root
    els.dialog.close()

    // 换了根目录，之前打开的标签全部失效
    closeAllTabs()
    await loadConfig()
  } catch (err) {
    els.rootError.textContent = err.message
  }
})

// ---------------------------------------------------------------- 分栏拖拽

const layout = document.querySelector('.layout')
const panes = document.querySelector('.panes')

document.querySelectorAll('.splitter').forEach((splitter) => {
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault()
    const which = splitter.dataset.resize
    const grid = which === 'sidebar' ? layout : panes
    let cols = getComputedStyle(grid).gridTemplateColumns.split(' ').map(parseFloat)
    let startX = e.clientX

    const onMove = (ev) => {
      const delta = ev.clientX - startX
      if (which === 'sidebar') {
        cols[0] = Math.max(140, cols[0] + delta)
      } else {
        // 拖动左右分隔条时，两侧等量反向变化
        cols[0] = Math.max(200, cols[0] + delta)
        cols[2] = Math.max(200, cols[2] - delta)
      }
      grid.style.gridTemplateColumns = cols.map((c) => `${c}px`).join(' ')
      startX = ev.clientX
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }

    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  })
})

// ---------------------------------------------------------------- 标签溢出下拉

/** 标签总宽超出可视区域时，显示下拉按钮列出全部标签 */
function updateTabOverflow() {
  const overflow = els.tabs.scrollWidth > els.tabs.clientWidth + 1
  els.btnTabList.hidden = !overflow || state.tabs.length === 0
  if (!overflow) setMenu(els.tabListPanel, false)
}

els.btnTabList.addEventListener('click', (e) => {
  e.stopPropagation()
  const willOpen = els.tabListPanel.hidden
  closeAllMenus()
  if (!willOpen) return

  els.tabListPanel.innerHTML = ''
  for (const tab of state.tabs) {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = tab.dirty ? 'menu__item is-on' : 'menu__item'
    item.textContent = tab.path
    item.title = tab.path
    item.addEventListener('click', () => {
      activateTab(tab.id)
      closeAllMenus()
    })
    els.tabListPanel.appendChild(item)
  }
  setMenu(els.tabListPanel, true)
})

new ResizeObserver(() => updateTabOverflow()).observe(els.tabs)

// ---------------------------------------------------------------- 右键菜单

function menuItem(label, action, disabled = false) {
  const item = document.createElement('button')
  item.type = 'button'
  item.className = 'menu__item'
  item.textContent = label
  item.disabled = disabled
  item.addEventListener('click', () => {
    closeAllMenus()
    action()
  })
  return item
}

function menuSep() {
  const sep = document.createElement('div')
  sep.className = 'menu__sep'
  return sep
}

function showContextMenu(x, y, entry) {
  els.contextMenu.innerHTML = ''

  // 新建的目标目录：右键目录就放进去，右键文件就放在它旁边
  const dir = entry.type === 'dir' ? entry.path : dirName(entry.path)

  els.contextMenu.appendChild(
    menuItem('新建文件', () => {
      selectedDir = dir
      createFile()
    })
  )
  els.contextMenu.appendChild(
    menuItem('新建文件夹', () => {
      selectedDir = dir
      createDir()
    })
  )
  els.contextMenu.appendChild(menuSep())
  els.contextMenu.appendChild(menuItem('重命名', () => renameEntry(entry)))
  els.contextMenu.appendChild(menuItem('删除（移入废纸篓）', () => deleteEntry(entry)))
  els.contextMenu.appendChild(menuSep())
  els.contextMenu.appendChild(
    menuItem('在访达中显示', () => {
      api.post('/api/reveal', { path: entry.path }).catch((err) => alert(`无法定位：${err.message}`))
    })
  )

  // 先显示再量尺寸，避免算出屏幕外的位置
  els.contextMenu.style.left = '0px'
  els.contextMenu.style.top = '0px'
  setMenu(els.contextMenu, true)

  const rect = els.contextMenu.getBoundingClientRect()
  els.contextMenu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`
  els.contextMenu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`
}

els.tree.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.tree__row')
  if (!row) return
  e.preventDefault()

  const path = row.dataset.path
  const isFile = Boolean(row.dataset.filePath)
  showContextMenu(e.clientX, e.clientY, {
    path,
    name: baseName(path),
    type: isFile ? 'file' : 'dir'
  })
})

// ---------------------------------------------------------------- 拖拽移动

let dragSource = null
let dragRowEl = null
let dropRowEl = null

/** 能不能把 source 移到 targetDir 里 */
function canDrop(source, targetDir) {
  if (!source) return false
  // 原地不动
  if (dirName(source.path) === targetDir) return false
  // 目录不能放进自己或自己的子孙里
  if (source.type === 'dir') {
    if (targetDir === source.path) return false
    if (targetDir.startsWith(source.path + '/')) return false
  }
  return true
}

function clearDropMarks() {
  if (dragRowEl) dragRowEl.classList.remove('is-dragging')
  if (dropRowEl) dropRowEl.classList.remove('is-drop-target')
  dropRowEl = null
}

els.tree.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.tree__row')
  if (!row) return

  dragSource = { path: row.dataset.path, type: row.dataset.filePath ? 'file' : 'dir' }
  dragRowEl = row
  row.classList.add('is-dragging')
  e.dataTransfer.effectAllowed = 'move'
  // 必须设一点数据，否则部分浏览器不会触发后续的拖放事件
  e.dataTransfer.setData('text/plain', dragSource.path)
})

els.tree.addEventListener('dragend', () => {
  dragSource = null
  clearDropMarks()
  dragRowEl = null
})

els.tree.addEventListener('dragover', (e) => {
  if (!dragSource) return
  const row = e.target.closest('.tree__row')

  // dragover 触发非常频繁，只在目标真的换了时才动 DOM
  if (row !== dropRowEl) {
    if (dropRowEl) dropRowEl.classList.remove('is-drop-target')
    dropRowEl = row
    if (row) {
      const targetDir = row.dataset.filePath ? dirName(row.dataset.path) : row.dataset.path
      if (canDrop(dragSource, targetDir)) row.classList.add('is-drop-target')
    }
  }

  if (!row) return
  const targetDir = row.dataset.filePath ? dirName(row.dataset.path) : row.dataset.path
  if (!canDrop(dragSource, targetDir)) return

  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
})

els.tree.addEventListener('dragleave', (e) => {
  if (!els.tree.contains(e.relatedTarget)) clearDropMarks()
})

els.tree.addEventListener('drop', async (e) => {
  const source = dragSource
  clearDropMarks()
  if (!source) return

  const row = e.target.closest('.tree__row')
  if (!row) return

  const targetDir = row.dataset.filePath ? dirName(row.dataset.path) : row.dataset.path
  if (!canDrop(source, targetDir)) return
  e.preventDefault()

  const to = joinPath(targetDir, baseName(source.path))
  try {
    const res = await api.post('/api/rename', { path: source.path, to })
    if (targetDir !== '.') expandedDirs.add(targetDir)
    afterPathChange(res.from, res.to)
  } catch (err) {
    alert(`移动失败：${err.message}`)
  }
})

// ---------------------------------------------------------------- 全文搜索

let searchTimer = null

function openSearch() {
  els.searchBar.hidden = false
  els.tree.hidden = true
  els.searchResults.hidden = false
  els.searchInput.focus()
  els.searchInput.select()
}

function closeSearch() {
  els.searchBar.hidden = true
  els.tree.hidden = false
  els.searchResults.hidden = true
  els.searchInput.value = ''
  els.searchResults.innerHTML = ''
}

async function runSearch() {
  const query = els.searchInput.value.trim()
  els.searchResults.innerHTML = ''

  if (!query) return
  els.searchResults.appendChild(hint('搜索中…', 'search-empty'))

  let data
  try {
    data = await api.get('/api/search', { q: query })
  } catch (err) {
    els.searchResults.innerHTML = ''
    els.searchResults.appendChild(hint(`搜索失败：${err.message}`, 'search-empty'))
    return
  }

  els.searchResults.innerHTML = ''

  if (!data.matches.length) {
    els.searchResults.appendChild(hint(`没有找到「${query}」（扫描了 ${data.files} 个文件）`, 'search-empty'))
    return
  }
  if (data.truncated) {
    els.searchResults.appendChild(hint(`结果过多，只显示前 ${data.matches.length} 条`, 'search-empty'))
  }

  for (const match of data.matches) {
    els.searchResults.appendChild(searchHitEl(match, query))
  }
}

function searchHitEl(match, query) {
  const el = document.createElement('div')
  el.className = 'search-hit'
  el.title = `${match.path}:${match.line}`

  const head = document.createElement('div')
  head.className = 'search-hit__head'
  head.textContent = `${match.path}:${match.line}`
  el.appendChild(head)

  const line = document.createElement('div')
  line.className = 'search-hit__line'

  const text = match.text.trim()
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) {
    line.textContent = text
  } else {
    line.innerHTML =
      escapeHtml(text.slice(0, idx)) +
      `<mark>${escapeHtml(text.slice(idx, idx + query.length))}</mark>` +
      escapeHtml(text.slice(idx + query.length))
  }
  el.appendChild(line)

  el.addEventListener('click', () => jumpToLine(match.path, match.line))
  return el
}

/** 打开文件并定位到指定行 */
async function jumpToLine(path, line) {
  await openFile({ path, name: baseName(path), type: 'file' })
  showRightPane('source')
  revealLine(line - 1)
  closeSearch()
}

function revealLine(line) {
  const doc = sourceEditor.getDoc()
  if (line < 0 || line >= doc.lineCount()) return
  sourceEditor.setCursor({ line, ch: 0 })
  sourceEditor.scrollIntoView({ line, ch: 0 }, 120)
  sourceEditor.focus()
}

els.btnSearch.addEventListener('click', () => (els.searchBar.hidden ? openSearch() : closeSearch()))
els.btnSearchClose.addEventListener('click', closeSearch)

els.searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(runSearch, 250)
})

els.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault()
    clearTimeout(searchTimer)
    runSearch()
  }
  if (e.key === 'Escape') closeSearch()
})

// ---------------------------------------------------------------- AI 引用跳转

/**
 * 回答里的行内代码如果能在当前文档里原样找到，就做成可点击的跳转。
 *
 * 刻意不用「让模型输出行号」的方案 —— 大模型数行号并不可靠。
 * 直接拿原文片段回文档里搜，既准确又不需要改提示词。
 */
function linkifyAiCode(container) {
  const tab = activeTab()
  if (!tab) return

  const content = tab.doc.getValue()
  for (const code of container.querySelectorAll('code')) {
    if (code.closest('pre')) continue
    const text = code.textContent.trim()
    if (text.length < 3) continue
    if (!content.includes(text)) continue

    code.classList.add('ai-ref')
    code.dataset.quote = text
    code.title = '点击定位到文档里的位置'
  }
}

function jumpToQuote(quote) {
  const tab = activeTab()
  if (!tab) return

  const idx = tab.doc.getValue().indexOf(quote)
  if (idx === -1) return

  showRightPane('source')
  revealLine(tab.doc.posFromIndex(idx).line)
}

els.aiMessages.addEventListener('click', (e) => {
  const ref = e.target.closest('.ai-ref')
  if (!ref || !ref.dataset.quote) return
  e.preventDefault()
  jumpToQuote(ref.dataset.quote)
})

// ---------------------------------------------------------------- 启动自检

/** 页面用到的全部接口。服务端少任何一个，就说明它是个旧进程 */
const REQUIRED_ROUTES = [
  'GET /api/config',
  'POST /api/config/root',
  'GET /api/tree',
  'GET /api/file',
  'PUT /api/file',
  'POST /api/file',
  'POST /api/dir',
  'POST /api/rename',
  'DELETE /api/entry',
  'POST /api/reveal',
  'GET /api/search',
  'GET /api/asset',
  'GET /api/watch',
  'POST /api/watch',
  'GET /api/ai/config',
  'POST /api/ai/config',
  'POST /api/ai/chat'
]

/**
 * 检查服务端是不是当前版本。
 *
 * 这个项目是「改完代码要重启本地服务」的形态，很容易出现「页面已经刷新到新版、
 * 但后台还是旧进程」的情况。旧进程的表现是「未知接口」这类没法排查的报错，
 * 所以启动时主动对一遍接口清单，直接给出可执行的提示。
 */
async function checkServerVersion() {
  const tip = '请关掉正在运行的那个服务窗口，然后重新双击 start.command 启动。'

  let routes
  try {
    const res = await api.get('/api/routes')
    routes = res.routes || []
  } catch {
    // 连自检接口都没有，说明是更早的版本
    window.showBootError(`服务端是旧版本（连自检接口都没有）。${tip}`)
    return
  }

  const missing = REQUIRED_ROUTES.filter((r) => !routes.includes(r))
  if (missing.length) {
    window.showBootError(
      `服务端是旧版本，缺少 ${missing.length} 个接口：${missing.join('、')}。${tip}`
    )
  }
}

// ---------------------------------------------------------------- 启动

checkServerVersion()

applyTheme(readPref(PREF_KEYS.theme, 'light'))
setAutosave(autosaveEnabled)
connectWatcher()

showEmptyState()
showRightPane('source')

loadAiConfig().catch((err) => {
  els.aiMessages.innerHTML = ''
  els.aiMessages.appendChild(hint(`读取 AI 配置失败：${err.message}`, 'ai-hint'))
})

loadConfig().catch((err) => {
  els.tree.innerHTML = ''
  els.tree.appendChild(hint(`初始化失败：${err.message}`, 'tree__error'))
})
