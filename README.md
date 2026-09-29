# edgeMark

在 **Edge** 里打开、编辑、浏览本机 Markdown 文件的本地管理器。

左侧是所见即所得编辑（MarkText / Typora 那种直接编辑排版结果、看不见 `#` 的感觉），
右侧可以看原始 markdown（与左侧双向同步），也可以切到 AI 助手就当前文档提问。

> 这是个**本地工具**：服务只监听 `127.0.0.1`，所有文件读写都限制在你选定的根目录内。

## 快速开始

需要 Node.js 18+。

```bash
git clone https://github.com/kerwinstudy/edgeMark.git
cd edgeMark
npm install
npm start
```

然后打开终端打印的地址（默认 <http://localhost:5178>）。

macOS 上也可以直接**双击 `start.command`**：会自动装依赖、启动服务、并用 Edge 打开。
终端窗口保持打开表示服务在运行，关掉或按 `Ctrl+C` 即停止。

首次打开会让你选一个**根目录**，之后所有浏览和编辑都被限制在这个目录内。

## 功能

- **所见即所得编辑**：看不见 markdown 标记，光标所在行才显示；工具栏 + 常用快捷键
- **多标签页**：标签上有未保存小圆点，`×` 或鼠标中键关闭，过多时出现下拉列表
- **左右双向同步**：右侧源码可编辑，改动互相同步
- **文件管理**：新建 / 重命名 / 删除（进废纸篓）/ 拖拽移动 / 右键菜单（含「在访达中显示」）
- **全文搜索**：结果带路径与行号，点击跳转
- **本地图片**：插入的图片存成文件、写相对路径；保存目录可全局设置也可按目录覆盖
- **自动保存**（可开关）、**外部改动监听**（别的程序改了会提示或自动重载）
- **深色主题**、**导出 HTML / PDF**
- **AI 助手**：读当前文档回答问题；也能直接改文件——改动先给你看 diff，确认后才应用

## 配置

配置在用户目录，**不在项目里**：

```
~/.edgemark/config.json     目录 0700、文件 0600
```

| 项 | 说明 |
| --- | --- |
| 根目录 | 首次打开时选，之后可在界面上换 |
| AI | Base URL / Model / API Key，兼容 OpenAI 接口格式 |
| 图片保存目录 | 默认 `assets`，在「···」菜单里改 |

AI 三项在右侧「AI 助手」→「设置」里填。**Base URL** 填 API 根地址即可
（如 `https://api.openai.com/v1`，会自动补 `/chat/completions`），任何兼容 OpenAI
接口格式的服务都行：OpenAI、DeepSeek、Moonshot，或本地的 Ollama / vLLM / LM Studio。

**API Key 是明文存储**（和 `~/.aws/credentials` 同一级别），但**不会回传给浏览器** ——
读配置的接口只回一个「有没有配」的布尔值。服务只监听 `127.0.0.1`。

跑自动化测试时用 `EDGEMARK_CONFIG` 指向别的配置文件，免得写到真实配置上：

```bash
EDGEMARK_CONFIG=/tmp/test-config.json npm start
```

## 快捷键

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 标题 1~6 | `Cmd+1` ~ `Cmd+6` | `Ctrl+Alt+1` ~ `Ctrl+Alt+6` |
| 代码块 | `Cmd+Shift+K` | `Ctrl+Shift+K` |
| 加粗 / 斜体 / 链接 | `Cmd+B` / `Cmd+I` / `Cmd+K` | `Ctrl+B` / `Ctrl+I` / `Ctrl+K` |
| 撤销 / 重做 | `Cmd+Z` / `Cmd+Y` | `Ctrl+Z` / `Ctrl+Y` |
| 保存 | `Cmd+S` | `Ctrl+S` |
| 列表自动续行 | `Enter` | `Enter` |

两个平台按键不同的原因：

- **标题**：macOS 上用的是 MarkText 的 `Cmd+数字`。Windows 上 `Ctrl+1`~`Ctrl+9` 是
  浏览器切换标签页的快捷键，**页面拦不住**，所以改用 `Ctrl+Alt+数字`
  （这是 Vditor 原生就支持的绑定）。
- **代码块**：MarkText 用的是 `⌥⌘C`，但那是 Edge 的「检查元素」，属于浏览器级快捷键、
  页面拦不住，所以两个平台都改用 Typora 的约定。

其余快捷键由 Vditor 自己处理，它会按平台把「主修饰键」映射成 `Cmd` 或 `Ctrl`。

## 平台支持

这个工具目前**以 macOS 为主**，除快捷键外还有几处是 macOS 专属：

| 功能 | macOS | Windows / Linux |
| --- | --- | --- |
| 编辑、搜索、图片、AI、导出 | ✅ | ✅ |
| `start.command` 双击启动 | ✅ | ❌（用 `npm start`） |
| 删除 → 废纸篓 | ✅ `~/.Trash` | ❌ 会报错 |
| 右键「在访达中显示」 | ✅ | ❌ 会报错 |

Windows 下需要的是「回收站 API」和「资源管理器定位」，目前没做。

## 说明

编辑器与渲染资源全部 vendor 在 `public/vendor/`，**无需构建步骤、完全离线可用**
（约 22MB，其中大部分是 Vditor 的图表渲染库）。

实现细节与设计取舍记在 **[docs/design-notes.md](docs/design-notes.md)**。

## 许可证

[MIT](LICENSE)。`public/vendor/` 下的第三方资源（Vditor / CodeMirror 5 / markdown-it /
Prism / github-markdown-css）均为 MIT。
