#!/usr/bin/env node
'use strict'

/**
 * edgeMark —— 本机 Markdown 管理器的本地服务。
 *
 * 只用 Node 内置模块，无后端依赖。职责：
 *   1. 提供 public/ 下的静态页面（CodeMirror 编辑器 + 实时预览）
 *   2. 提供一组受限的文件 API，所有路径都必须落在「根目录」之内
 *
 * 启动：node server/index.js [--open] [--port=5178]
 */

const http = require('node:http')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')

const PROJECT_DIR = path.resolve(__dirname, '..')
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public')

// 配置放在用户目录而不是项目目录：这样复制 / 分享 / 打包项目时不会把 API Key 一起带走
const CONFIG_DIR = path.join(os.homedir(), '.edgemark')
/**
 * 配置文件位置。
 *
 * 设了 EDGEMARK_CONFIG 就用它 —— **自动化测试必须走这个变量**，
 * 否则测试会直接写到用户真实的配置上，把里面的 API Key 覆盖掉。
 */
const CONFIG_PATH = process.env.EDGEMARK_CONFIG
  ? path.resolve(process.env.EDGEMARK_CONFIG)
  : path.join(CONFIG_DIR, 'config.json')
const CONFIG_IS_OVERRIDDEN = Boolean(process.env.EDGEMARK_CONFIG)
/** 旧版本把配置放在项目目录里，首次启动会自动迁过来 */
const LEGACY_CONFIG_PATH = path.join(PROJECT_DIR, '.edgemark-config.json')

const DEFAULT_PORT = 5178
const MAX_BODY = 32 * 1024 * 1024 // 单次写入上限 32MB

/** 认作可编辑文本的扩展名 */
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdx',
  '.txt', '.text', '.rst'
])
/** 目录树里不展开的目录 */
const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.idea', '.vscode',
  'dist', 'build', 'out', '.cache', '.next', '.venv', '__pycache__', '.DS_Store'
])

// ---------------------------------------------------------------- 配置

const defaultRoot = () => {
  const docs = path.join(os.homedir(), 'Documents')
  return fs.existsSync(docs) ? docs : os.homedir()
}

const DEFAULT_AI = { baseUrl: 'https://api.openai.com/v1', model: '', apiKey: '' }

function readConfigFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 把旧版留在项目目录里的配置迁到用户目录。
 * 迁完会删掉旧文件 —— 旧文件里含明文 API Key，留着就失去了「挪出项目目录」的意义。
 * 但删除前会先读回来核对，确认新文件写对了才删，避免丢配置。
 */
function migrateLegacyConfig() {
  // 用外部指定的配置文件时不做迁移（那多半是测试环境）
  if (CONFIG_IS_OVERRIDDEN) return
  if (fs.existsSync(CONFIG_PATH)) return
  if (!fs.existsSync(LEGACY_CONFIG_PATH)) return

  const legacy = readConfigFile(LEGACY_CONFIG_PATH)
  if (!legacy) {
    console.warn('[edgeMark] 旧的配置文件无法解析，保留原样：', LEGACY_CONFIG_PATH)
    return
  }

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(legacy, null, 2), { mode: 0o600 })
    fs.chmodSync(CONFIG_PATH, 0o600)

    const written = readConfigFile(CONFIG_PATH)
    const same =
      written &&
      written.root === legacy.root &&
      written.ai &&
      legacy.ai &&
      written.ai.apiKey === legacy.ai.apiKey

    if (!same) {
      console.warn('[edgeMark] 配置迁移后校验不一致，已保留旧文件：', LEGACY_CONFIG_PATH)
      return
    }

    fs.unlinkSync(LEGACY_CONFIG_PATH)
    console.log(`[edgeMark] 配置已迁移到 ${CONFIG_PATH}，旧的已删除`)
  } catch (err) {
    console.warn('[edgeMark] 配置迁移失败（继续用旧文件）：', err.message)
  }
}

migrateLegacyConfig()

const activeConfigPath = () => (fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : LEGACY_CONFIG_PATH)

let config = { root: defaultRoot(), recentRoots: [], ai: { ...DEFAULT_AI } }
{
  const raw = readConfigFile(activeConfigPath())
  if (raw) {
    if (typeof raw.root === 'string' && fs.existsSync(raw.root)) config.root = raw.root
    if (Array.isArray(raw.recentRoots)) config.recentRoots = raw.recentRoots.slice(0, 10)
    if (raw.ai && typeof raw.ai === 'object') {
      for (const key of Object.keys(DEFAULT_AI)) {
        if (typeof raw.ai[key] === 'string') config.ai[key] = raw.ai[key]
      }
    }
  }
}

/** 配置里含 API Key：目录 0700、文件 0600（仅本人可读写） */
const persistConfig = () => {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 })
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 })
    fs.chmodSync(CONFIG_PATH, 0o600)
    // 迁移失败时旧文件还在，写入后清掉它，避免两份配置并存
    if (fs.existsSync(LEGACY_CONFIG_PATH)) fs.unlinkSync(LEGACY_CONFIG_PATH)
  } catch (err) {
    console.warn('[edgeMark] 配置写入失败：', err.message)
  }
}

// ---------------------------------------------------------------- 工具

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** 把前端传来的相对路径解析成绝对路径，并确保没有越出根目录 */
function resolveInsideRoot(relPath) {
  const rel = (relPath || '.').replace(/^[/\\]+/, '')
  const abs = path.resolve(config.root, rel)
  const root = path.resolve(config.root)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new HttpError(403, '路径越出根目录')
  }
  return abs
}

/** 绝对路径 → 相对根目录的展示路径（统一用 / 分隔） */
function toRelative(abs) {
  const rel = path.relative(config.root, abs)
  return rel.split(path.sep).join('/')
}

function isTextFile(name) {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())
}

const exists = (p) =>
  fsp.access(p).then(
    () => true,
    () => false
  )

/**
 * 移入系统废纸篓。
 *
 * 只做同卷 rename —— 跨卷（比如根目录在外接硬盘上）会失败，这时明确报错，
 * **绝不退化成永久删除**。宁可删不掉，也不能把用户的数据真删了。
 */
async function moveToTrash(abs) {
  const trashDir = path.join(os.homedir(), '.Trash')
  const trashStat = await fsp.stat(trashDir).catch(() => null)
  if (!trashStat || !trashStat.isDirectory()) {
    throw new HttpError(500, `找不到废纸篓目录：${trashDir}`)
  }

  // 重名时加时间戳后缀，绝不覆盖废纸篓里已有的东西
  const ext = path.extname(abs)
  const base = path.basename(abs, ext)
  let target = path.join(trashDir, path.basename(abs))
  if (await exists(target)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    target = path.join(trashDir, `${base} ${stamp}${ext}`)
  }

  try {
    await fsp.rename(abs, target)
  } catch (err) {
    if (err.code === 'EXDEV') {
      throw new HttpError(400, '这个位置不在系统盘上，无法移入废纸篓。请用访达手动删除。')
    }
    throw new HttpError(500, `移入废纸篓失败：${err.message}`)
  }

  return path.basename(target)
}

/** 新建时的名称校验：目录树不显示隐藏文件，所以不让建 */
function assertCreatable(abs) {
  const name = path.basename(abs)
  if (!name || name === '.' || name === '..') throw new HttpError(400, '名称不合法')
  if (name.startsWith('.')) {
    throw new HttpError(400, '不能创建以「.」开头的名称（目录树不显示隐藏文件）')
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
}

// ---------------------------------------------------------------- API

const api = {
  /** 当前根目录与常用目录 */
  async 'GET /api/config'() {
    const home = os.homedir()
    const shortcuts = [
      { label: '主目录', path: home },
      { label: '文稿', path: path.join(home, 'Documents') },
      { label: '桌面', path: path.join(home, 'Desktop') },
      { label: '下载', path: path.join(home, 'Downloads') }
    ].filter((s) => fs.existsSync(s.path))

    return { root: config.root, recentRoots: config.recentRoots, shortcuts }
  },

  /** 切换根目录 */
  async 'POST /api/config/root'(body) {
    const target = String(body.root || '').trim()
    if (!target) throw new HttpError(400, '缺少 root')
    const abs = path.resolve(target.replace(/^~(?=$|\/)/, os.homedir()))
    let stat
    try {
      stat = await fsp.stat(abs)
    } catch {
      throw new HttpError(404, `目录不存在：${abs}`)
    }
    if (!stat.isDirectory()) throw new HttpError(400, `不是目录：${abs}`)

    config.root = abs
    config.recentRoots = [abs, ...config.recentRoots.filter((r) => r !== abs)].slice(0, 10)
    persistConfig()
    return { root: config.root, recentRoots: config.recentRoots }
  },

  /** 列出一个目录的直接子项（目录 + 可编辑文本文件） */
  async 'GET /api/tree'(query) {
    const dir = resolveInsideRoot(query.dir)
    const entries = await fsp.readdir(dir, { withFileTypes: true })

    const items = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
      const abs = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        items.push({ name: entry.name, path: toRelative(abs), type: 'dir' })
      } else if (entry.isFile() && isTextFile(entry.name)) {
        const stat = await fsp.stat(abs)
        items.push({
          name: entry.name,
          path: toRelative(abs),
          type: 'file',
          size: stat.size,
          mtime: stat.mtimeMs
        })
      }
    }

    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
    })

    return { dir: toRelative(dir) === '' ? '.' : toRelative(dir), entries: items }
  },

  /** 读取一个文本文件 */
  async 'GET /api/file'(query) {
    const abs = resolveInsideRoot(query.path)
    const stat = await fsp.stat(abs).catch(() => null)
    if (!stat || !stat.isFile()) throw new HttpError(404, '文件不存在')

    const buf = await fsp.readFile(abs)
    if (buf.includes(0)) throw new HttpError(415, '看起来是二进制文件，无法以文本方式编辑')

    return {
      path: toRelative(abs),
      name: path.basename(abs),
      content: buf.toString('utf8'),
      size: stat.size,
      mtime: stat.mtimeMs
    }
  },

  /** 保存文本文件 */
  async 'PUT /api/file'(body) {
    const abs = resolveInsideRoot(body.path)
    if (typeof body.content !== 'string') throw new HttpError(400, '缺少 content')

    const stat = await fsp.stat(abs).catch(() => null)
    if (!stat) throw new HttpError(404, '文件不存在（第一版不支持新建文件）')
    if (!stat.isFile()) throw new HttpError(400, '目标不是文件')

    await fsp.writeFile(abs, body.content, 'utf8')
    const next = await fsp.stat(abs)
    return { path: toRelative(abs), size: next.size, mtime: next.mtimeMs }
  },

  // ------------------------------------------------------------ 文件管理

  /** 新建文件 */
  async 'POST /api/file'(body) {
    if (typeof body.path !== 'string' || !body.path.trim()) throw new HttpError(400, '缺少 path')
    const abs = resolveInsideRoot(body.path)
    assertCreatable(abs)
    if (await exists(abs)) throw new HttpError(409, `已经存在：${toRelative(abs)}`)

    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, typeof body.content === 'string' ? body.content : '', 'utf8')
    return { path: toRelative(abs) }
  },

  /** 新建文件夹 */
  async 'POST /api/dir'(body) {
    if (typeof body.path !== 'string' || !body.path.trim()) throw new HttpError(400, '缺少 path')
    const abs = resolveInsideRoot(body.path)
    assertCreatable(abs)
    if (await exists(abs)) throw new HttpError(409, `已经存在：${toRelative(abs)}`)

    await fsp.mkdir(abs, { recursive: true })
    return { path: toRelative(abs) }
  },

  /** 重命名 / 移动（同一套逻辑，改的是路径） */
  async 'POST /api/rename'(body) {
    if (typeof body.path !== 'string' || typeof body.to !== 'string') {
      throw new HttpError(400, '需要 path 和 to')
    }
    const from = resolveInsideRoot(body.path)
    const to = resolveInsideRoot(body.to)

    if (from === path.resolve(config.root)) throw new HttpError(400, '不能重命名根目录')
    if (!(await exists(from))) throw new HttpError(404, `不存在：${toRelative(from)}`)
    if (from === to) return { from: toRelative(from), to: toRelative(to) }
    if (await exists(to)) throw new HttpError(409, `目标已存在：${toRelative(to)}`)
    assertCreatable(to)

    await fsp.mkdir(path.dirname(to), { recursive: true })
    await fsp.rename(from, to)
    return { from: toRelative(from), to: toRelative(to) }
  },

  /** 删除：移入废纸篓，不做永久删除 */
  async 'DELETE /api/entry'(body) {
    if (typeof body.path !== 'string' || !body.path.trim()) throw new HttpError(400, '缺少 path')
    const abs = resolveInsideRoot(body.path)

    if (abs === path.resolve(config.root)) throw new HttpError(400, '不能删除根目录')
    if (!(await exists(abs))) throw new HttpError(404, `不存在：${toRelative(abs)}`)

    const trashedAs = await moveToTrash(abs)
    return { path: toRelative(abs), trashedAs }
  },

  // ------------------------------------------------------------ 自检

  /**
   * 暴露服务端实际注册了哪些接口。
   * 前端启动时会拿它和自己需要的接口对一遍 —— 页面是新的、服务端是旧进程时，
   * 会直接提示「请重启服务」，而不是让用户看到「未知接口」这种没法排查的报错。
   */
  async 'GET /api/routes'() {
    return { routes: Object.keys(api).concat(Object.keys(streamApi)) }
  },

  // ------------------------------------------------------------ AI 配置

  /** 读 AI 配置。注意：永远不把 apiKey 本身发给浏览器 */
  async 'GET /api/ai/config'() {
    return {
      baseUrl: config.ai.baseUrl,
      model: config.ai.model,
      hasApiKey: Boolean(config.ai.apiKey)
    }
  },

  /**
   * 写 AI 配置。
   * apiKey 省略或为 null → 保持不变（这样设置界面不必把密钥回显出来）；
   * apiKey 为 '' → 清除。
   */
  async 'POST /api/ai/config'(body) {
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
      config.ai.baseUrl = body.baseUrl.trim()
    }
    if (typeof body.model === 'string') {
      config.ai.model = body.model.trim()
    }
    if (typeof body.apiKey === 'string') {
      config.ai.apiKey = body.apiKey.trim()
    }
    persistConfig()
    return {
      baseUrl: config.ai.baseUrl,
      model: config.ai.model,
      hasApiKey: Boolean(config.ai.apiKey)
    }
  }
}

// ---------------------------------------------------------------- AI 对话代理
/**
 * 用户填的可能是 API 根地址（https://api.openai.com/v1），
 * 也可能直接把完整端点粘进来了，两种都兼容。
 */
function buildChatUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) throw new HttpError(400, '还没有配置 Base URL')
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
}

/**
 * 把上游的 OpenAI 格式 SSE 收敛成我们自己的最小协议，前端就不用关心各家的差异：
 *   data: {"delta":"..."}   增量文本
 *   data: {"error":"..."}   错误
 *   data: [DONE]            结束
 */
function makeSseWriter(res) {
  return {
    delta(text) {
      res.write(`data: ${JSON.stringify({ delta: text })}\n\n`)
    },
    error(message) {
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`)
    },
    done() {
      res.write('data: [DONE]\n\n')
      res.end()
    }
  }
}

/** 从一行 SSE data 里取出增量文本 */
function extractDelta(payload) {
  const obj = JSON.parse(payload)
  const choice = obj.choices && obj.choices[0]
  if (!choice) return ''
  return (choice.delta && choice.delta.content) || (choice.message && choice.message.content) || ''
}

const streamApi = {
  /** 转发一次对话请求，流式回传给浏览器 */
  async 'POST /api/ai/chat'(body, req, res) {
    const { baseUrl, model, apiKey } = config.ai
    if (!apiKey) throw new HttpError(400, '还没有配置 API Key，请先在「AI 设置」里填写')
    if (!model) throw new HttpError(400, '还没有配置模型名（Model）')

    const messages = Array.isArray(body.messages) ? body.messages : null
    if (!messages || !messages.length) throw new HttpError(400, '缺少 messages')

    const controller = new AbortController()
    // 用 res 而不是 req：Node 16+ 里 req 的 'close' 在请求体读完时就会触发，
    // 会在流还没开始时就误中止上游。writableEnded 用来区分正常结束和客户端提前断开。
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })

    let upstream
    try {
      upstream = await fetch(buildChatUrl(baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ model, messages, stream: true })
      })
    } catch (err) {
      throw new HttpError(502, `连接上游失败：${err.message}`)
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '')
      throw new HttpError(upstream.status, `上游返回 ${upstream.status}：${detail.slice(0, 600) || '（无内容）'}`)
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    const sse = makeSseWriter(res)

    try {
      const contentType = upstream.headers.get('content-type') || ''

      if (!contentType.includes('text/event-stream')) {
        // 上游没按流式返回，整体读出来一次性下发
        const data = await upstream.json().catch(() => null)
        const choice = data && data.choices && data.choices[0]
        const content = (choice && ((choice.message && choice.message.content) || choice.text)) || ''
        if (content) sse.delta(content)
        sse.done()
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''

      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() // 最后一段可能不完整，留到下一轮

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (!payload) continue
          if (payload === '[DONE]') {
            sse.done()
            return
          }
          try {
            const delta = extractDelta(payload)
            if (delta) sse.delta(delta)
          } catch {
            /* 单行解析失败就跳过，不打断整个回答 */
          }
        }
      }

      sse.done()
    } catch (err) {
      if (controller.signal.aborted) {
        // 浏览器主动断开，不算错误
        res.end()
        return
      }
      sse.error(err.message)
      res.end()
    }
  }
}

// ---------------------------------------------------------------- 静态资源

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  const abs = path.resolve(PUBLIC_DIR, rel)
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) {
    throw new HttpError(403, '非法路径')
  }

  const stat = await fsp.stat(abs).catch(() => null)
  if (!stat || !stat.isFile()) throw new HttpError(404, 'Not Found')

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache'
  })
  fs.createReadStream(abs).pipe(res)
}

// ---------------------------------------------------------------- 服务器

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const route = `${req.method} ${url.pathname}`

  try {
    // 流式接口自己接管 res，不返回 JSON
    if (streamApi[route]) {
      await streamApi[route](await readBody(req), req, res)
      return
    }

    if (api[route]) {
      const query = Object.fromEntries(url.searchParams)
      const body = req.method === 'GET' ? {} : await readBody(req)
      json(res, 200, await api[route](req.method === 'GET' ? query : body))
      return
    }
    if (url.pathname.startsWith('/api/')) throw new HttpError(404, '未知接口')
    await serveStatic(req, res, url.pathname)
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500
    if (status === 500) console.error('[edgeMark]', err)
    if (!res.headersSent) json(res, status, { error: err.message })
    else res.end()
  }
})

/** 端口被占用时顺延，最多试 20 个 */
function listen(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) {
      listen(port + 1, attempt + 1)
    } else {
      console.error('[edgeMark] 启动失败：', err.message)
      process.exit(1)
    }
  })

  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`
    console.log('')
    console.log('  edgeMark 已启动')
    console.log(`  根目录：${config.root}`)
    console.log(`  地址：  ${url}`)
    console.log('')
    console.log('  按 Ctrl+C 停止服务')
    console.log('')

    if (process.argv.includes('--open')) openInEdge(url)
  })
}

const EDGE_APP = 'Microsoft Edge'

/** 用 Edge 打开；只有 Edge 确实不存在时才退回系统默认浏览器 */
function openInEdge(url) {
  execFile('open', ['-a', EDGE_APP, url], (err) => {
    if (!err) return
    console.warn(`[edgeMark] 没能用 ${EDGE_APP} 打开（${err.message}），改用默认浏览器`)
    execFile('open', [url])
  })
}

const portArg = process.argv.find((a) => a.startsWith('--port='))
listen(portArg ? Number(portArg.split('=')[1]) : DEFAULT_PORT)
