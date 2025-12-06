# TeX E2C - VS Code Extension

LaTeX 中英文同步翻译插件。

## 功能

- 中文→英文：将中文内容翻译成英文，原中文变为注释
- 英文→中文注释：为英文内容添加中文注释
- 双向同步：修改任一方自动更新另一方

## 安装

```bash
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

然后在 VS Code 中通过 `Extensions: Install from VSIX` 安装生成的 `.vsix` 文件。

## 配置

在设置中搜索 `tex-e2c` 进行配置：

- `apiBaseUrl`: API 地址
- `apiKey`: API 密钥
- `model`: 翻译模型

## 使用

1. 打开 `.tex` 文件
2. 点击状态栏或按 `Ctrl+Alt+T`
3. 等待翻译完成

详细说明请查看项目根目录的 README.md。

