# TeX E2C - LaTeX 中英文同步翻译插件

<p align="center">
  <img src="vscode-extension/images/icon.svg" width="128" height="128" alt="TeX E2C Logo">
</p>

<p align="center">
  <b>用中文写论文，一键翻译成英文</b><br>
  <b>或为英文论文添加中文注释，方便理解</b>
</p>

---

## ✨ 功能特点

- 🔄 **双向翻译**：中文→英文 / 英文→中文注释
- 📝 **原地编辑**：无需生成新文件，翻译结果直接嵌入原文档
- 💾 **智能缓存**：相同内容不重复翻译，节省API费用
- 🔗 **双向同步**：修改中文自动更新英文，修改英文自动更新中文
- ⌨️ **快捷操作**：支持快捷键和右键菜单
- 🎨 **高亮显示**：中文内容和注释标记自动高亮

## 📦 安装方法

### 方法一：从 Release 下载安装（推荐）

1. 前往 [Releases](https://github.com/Jaywalk18/TEX-E2C/releases) 页面
2. 下载最新版本的 `tex-e2c-x.x.x.vsix` 文件
3. 打开 VS Code / Cursor
4. 按 `Ctrl+Shift+P` 打开命令面板
5. 输入 `Extensions: Install from VSIX`
6. 选择下载的 `.vsix` 文件
7. 按 `Ctrl+Shift+P`，输入 `Reload Window` 重新加载窗口

### 方法二：从源码构建

```bash
cd vscode-extension
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

## ⚙️ 配置

### 1. 配置 API

首次使用需要配置翻译 API。支持任何 OpenAI 兼容的 API 服务：

| 服务 | API 地址 | 说明 |
|------|----------|------|
| OpenAI 官方 | `https://api.openai.com/v1` | 需要海外网络 |
| DeepSeek | `https://api.deepseek.com/v1` | 国内可用，性价比高 |
| 硅基流动 | `https://api.siliconflow.cn/v1` | 国内可用 |
| 其他代理 | 自定义 | 支持 OpenAI 兼容接口 |

配置步骤：
1. 点击侧边栏 **TeX E2C** 图标
2. 点击 **API 地址** 或 **API 密钥** 进行配置
3. 选择翻译模型（推荐 `gpt-4o-mini` 或 `deepseek-chat`）

### 2. 设置选项

在 VS Code 设置中搜索 `tex-e2c`：

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| `apiBaseUrl` | API 基础 URL | - |
| `apiKey` | API 密钥 | - |
| `model` | 翻译模型 | `gpt-4o-mini` |
| `markerPrefix` | 中文标记前缀 | `% @cn:` |
| `autoTranslateOnSave` | 保存时自动翻译 | `off` |
| `autoAddMarkerOnNewline` | 换行自动添加标记 | `true` |

## 🚀 使用方法

### 场景一：中文论文翻译成英文

1. 用中文写好论文内容
2. 打开 `.tex` 文件
3. 点击左下角状态栏 `中→英` 或按 `Ctrl+Alt+T`
4. 等待翻译完成

**翻译前：**
```latex
\section{引言}

图像分类是计算机视觉领域的一个基础任务。
```

**翻译后：**
```latex
% @cn: \section{引言}
\section{Introduction}

% @cn: 图像分类是计算机视觉领域的一个基础任务。
Image classification is a fundamental task in the field of computer vision.
```

### 场景二：为英文论文添加中文注释

1. 打开英文 `.tex` 文件
2. 点击左下角状态栏 `英→中` 
3. 等待翻译完成

**翻译后：**
```latex
% @cn: 图像分类是计算机视觉领域的一个基础任务。
Image classification is a fundamental task in the field of computer vision.
```

### 场景三：修改后同步

- **修改中文注释** → 点击"同步更新" → 英文自动更新
- **修改英文内容** → 点击"同步更新" → 中文注释自动更新
- **新增中文注释** → 点击"同步更新" → 自动补上英文翻译

## ⌨️ 快捷键

| 功能 | 快捷键 |
|------|--------|
| 全文翻译 | `Ctrl+Alt+T` |

可在 `Ctrl+K Ctrl+S` 中自定义其他快捷键。

## 📁 项目结构

```
Tex_E2C/
├── README.md                 # 本文件
├── examples/                 # 示例文件
│   ├── sample_chinese.tex    # 中文示例
│   └── sample_english.tex    # 英文示例
└── vscode-extension/         # VS Code 插件源码
    ├── src/                  # TypeScript 源码
    ├── images/               # 图标
    ├── package.json          # 插件配置
    └── ...
```

## 🔧 构建说明

### 环境要求

- Node.js >= 18
- npm >= 9

### 构建步骤

```bash
# 进入插件目录
cd vscode-extension

# 安装依赖
npm install

# 编译 TypeScript
npm run compile

# 打包成 VSIX
npx @vscode/vsce package --allow-missing-repository
```

## 📝 使用技巧

### 1. 中文注释换行

在 `% @cn:` 行按回车，新行会自动添加 `% @cn:` 前缀：

```latex
% @cn: 第一行中文
% @cn: 第二行中文（自动添加前缀）
Combined English translation.
```

### 2. 保存时自动翻译

在设置中将 `autoTranslateOnSave` 改为：
- `auto`：自动检测并翻译
- `cn2en`：中文→英文
- `en2cn`：英文→中文注释
- `sync`：同步更新

### 3. 与 LaTeX Workshop 配合

本插件只负责翻译，编译由 LaTeX Workshop 完成：
1. 用 TeX E2C 翻译
2. 用 LaTeX Workshop 编译 PDF

## ❓ 常见问题

### Q: 提示 "Country, region, or territory not supported"

这是 OpenAI 官方 API 的地区限制。解决方案：
- 使用 DeepSeek 等国内可用的 API
- 使用第三方代理服务

### Q: 翻译后 LaTeX 命令被翻译了

正常情况下不会翻译 `\section`、`\begin` 等命令。如果出现这种情况，请在 GitHub 提交 Issue。

### Q: 如何清除翻译缓存？

点击侧边栏 → 操作 → 清除缓存

## 📄 License

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

<p align="center">
  Made with ❤️ for academic writing
</p>

