import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { SyncTranslator } from './translator';
import { ConfigTreeProvider, StatusTreeProvider, ActionsTreeProvider } from './views';

let translator: SyncTranslator;
let statusBarItem: vscode.StatusBarItem;
let configTreeProvider: ConfigTreeProvider;
let statusTreeProvider: StatusTreeProvider;
let actionsTreeProvider: ActionsTreeProvider;
let outputChannel: vscode.OutputChannel;

// 装饰器：用于高亮中文内容
let chineseDecorationType: vscode.TextEditorDecorationType;
let markerDecorationType: vscode.TextEditorDecorationType;

export function activate(context: vscode.ExtensionContext) {
    console.log('TeX E2C 插件已激活');

    // 创建输出通道
    outputChannel = vscode.window.createOutputChannel('TeX E2C');

    // 初始化翻译器
    translator = new SyncTranslator(context, outputChannel);

    // 创建装饰器
    chineseDecorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(255, 200, 0, 0.2)',
        border: '1px solid rgba(255, 180, 0, 0.4)',
        borderRadius: '3px'
    });

    markerDecorationType = vscode.window.createTextEditorDecorationType({
        color: 'rgba(100, 180, 100, 0.8)',
        fontStyle: 'italic'
    });

    // 创建状态栏
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(globe) TeX E2C';
    statusBarItem.tooltip = '点击翻译全文 (Ctrl+Alt+T)';
    statusBarItem.command = 'tex-e2c.translateAll';
    context.subscriptions.push(statusBarItem);

    // 创建树视图
    configTreeProvider = new ConfigTreeProvider();
    statusTreeProvider = new StatusTreeProvider(translator);
    actionsTreeProvider = new ActionsTreeProvider();
    
    vscode.window.registerTreeDataProvider('tex-e2c.config', configTreeProvider);
    vscode.window.registerTreeDataProvider('tex-e2c.status', statusTreeProvider);
    vscode.window.registerTreeDataProvider('tex-e2c.actions', actionsTreeProvider);

    // 注册命令
    const commands = [
        vscode.commands.registerCommand('tex-e2c.translateAll', () => translateAllCommand(false)),
        vscode.commands.registerCommand('tex-e2c.translateAllForce', () => translateAllCommand(true)),
        vscode.commands.registerCommand('tex-e2c.addChineseComments', () => addChineseCommentsCommand(false)),
        vscode.commands.registerCommand('tex-e2c.addChineseCommentsForce', () => addChineseCommentsCommand(true)),
        vscode.commands.registerCommand('tex-e2c.sync', syncCommand),
        vscode.commands.registerCommand('tex-e2c.translateSelection', translateSelectionCommand),
        vscode.commands.registerCommand('tex-e2c.clearCache', clearCacheCommand),
        vscode.commands.registerCommand('tex-e2c.configureApi', configureApiCommand),
        vscode.commands.registerCommand('tex-e2c.fetchModels', fetchModelsCommand),
        vscode.commands.registerCommand('tex-e2c.selectModel', selectModelCommand),
    ];

    commands.forEach(cmd => context.subscriptions.push(cmd));

    // 监听编辑器变化
    vscode.window.onDidChangeActiveTextEditor(editor => {
        updateStatusBar(editor);
        updateDecorations(editor);
    });

    vscode.workspace.onDidChangeTextDocument(event => {
        const editor = vscode.window.activeTextEditor;
        if (editor && event.document === editor.document) {
            updateDecorations(editor);
            updateStatusBar(editor);
            statusTreeProvider.refresh();
        }
    });

    // 监听保存事件 - 自动翻译
    vscode.workspace.onDidSaveTextDocument(async document => {
        if (document.languageId !== 'latex') return;
        
        const config = vscode.workspace.getConfiguration('tex-e2c');
        const autoTranslateOnSave = config.get<string>('autoTranslateOnSave', 'off');
        const apiKey = config.get<string>('apiKey', '');
        
        if (autoTranslateOnSave === 'off' || !apiKey) return;

        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === document.uri.toString()
        );
        if (!editor) return;

        // 检测文档类型
        const chineseBlocks = translator.scanChineseBlocks(document);
        const englishBlocks = translator.scanEnglishBlocks(document);

        statusBarItem.text = '$(sync~spin) 自动翻译中...';

        try {
            if (autoTranslateOnSave === 'cn2en' && chineseBlocks.length > 0) {
                // 中文→英文
                await translator.translateDocument(document, false);
                vscode.window.setStatusBarMessage('✓ 中文已翻译成英文', 3000);
            } else if (autoTranslateOnSave === 'en2cn' && englishBlocks.length > 0) {
                // 英文→中文注释
                await translator.addChineseComments(document, false);
                vscode.window.setStatusBarMessage('✓ 已添加中文注释', 3000);
            } else if (autoTranslateOnSave === 'sync') {
                // 同步更新
                await translator.syncDocument(document);
                vscode.window.setStatusBarMessage('✓ 翻译已同步', 3000);
            } else if (autoTranslateOnSave === 'auto') {
                // 自动检测
                if (chineseBlocks.length > 0) {
                    await translator.translateDocument(document, false);
                    vscode.window.setStatusBarMessage('✓ 中文已翻译成英文', 3000);
                } else if (englishBlocks.length > 0) {
                    await translator.addChineseComments(document, false);
                    vscode.window.setStatusBarMessage('✓ 已添加中文注释', 3000);
                } else {
                    await translator.syncDocument(document);
                    vscode.window.setStatusBarMessage('✓ 翻译已同步', 3000);
                }
            }
        } catch (error) {
            outputChannel.appendLine(`[自动翻译错误] ${error}`);
        }

        updateStatusBar(editor);
        updateDecorations(editor);
        statusTreeProvider.refresh();
    });

    // 监听回车键 - 在中文注释行自动添加标识符
    vscode.workspace.onDidChangeTextDocument(event => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document !== event.document || editor.document.languageId !== 'latex') {
            return;
        }

        const config = vscode.workspace.getConfiguration('tex-e2c');
        const autoAddMarker = config.get<boolean>('autoAddMarkerOnNewline', true);
        if (!autoAddMarker) return;

        const markerPrefix = translator.getMarkerPrefix();

        for (const change of event.contentChanges) {
            // 检测是否是插入换行符
            if (change.text.includes('\n') && change.rangeLength === 0) {
                const lineNumber = change.range.start.line;
                const currentLine = editor.document.lineAt(lineNumber).text;
                
                // 如果当前行是中文注释行
                if (currentLine.trim().startsWith(markerPrefix)) {
                    const indent = currentLine.match(/^(\s*)/)?.[1] || '';
                    
                    // 延迟插入，确保换行已完成
                    setTimeout(async () => {
                        const newLineNumber = lineNumber + 1;
                        if (newLineNumber < editor.document.lineCount) {
                            const newLine = editor.document.lineAt(newLineNumber);
                            // 如果新行是空的或只有空格
                            if (newLine.text.trim() === '' || newLine.text === indent) {
                                await editor.edit(editBuilder => {
                                    const pos = new vscode.Position(newLineNumber, 0);
                                    editBuilder.replace(
                                        new vscode.Range(pos, new vscode.Position(newLineNumber, newLine.text.length)),
                                        `${indent}${markerPrefix} `
                                    );
                                });
                                // 移动光标到标识符后
                                const newPos = new vscode.Position(newLineNumber, indent.length + markerPrefix.length + 1);
                                editor.selection = new vscode.Selection(newPos, newPos);
                            }
                        }
                    }, 10);
                }
            }
        }
    });

    // 初始化
    updateStatusBar(vscode.window.activeTextEditor);
    updateDecorations(vscode.window.activeTextEditor);
}

function updateStatusBar(editor: vscode.TextEditor | undefined) {
    if (editor && editor.document.languageId === 'latex') {
        statusBarItem.show();
        
        // 扫描中文块和英文块
        const chineseBlocks = translator.scanChineseBlocks(editor.document);
        const englishBlocks = translator.scanEnglishBlocks(editor.document);
        
        if (chineseBlocks.length > 0) {
            // 有中文待翻译
            statusBarItem.text = `$(globe) 中→英 (${chineseBlocks.length})`;
            statusBarItem.tooltip = `${chineseBlocks.length} 处中文待翻译成英文\n点击翻译`;
            statusBarItem.command = 'tex-e2c.translateAll';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else if (englishBlocks.length > 0) {
            // 有英文可添加注释
            statusBarItem.text = `$(comment) 英→中 (${englishBlocks.length})`;
            statusBarItem.tooltip = `${englishBlocks.length} 处英文可添加中文注释\n点击添加`;
            statusBarItem.command = 'tex-e2c.addChineseComments';
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            statusBarItem.text = '$(check) TeX E2C';
            statusBarItem.tooltip = '翻译已完成';
            statusBarItem.command = 'tex-e2c.sync';
            statusBarItem.backgroundColor = undefined;
        }
    } else {
        statusBarItem.hide();
    }
}

function updateDecorations(editor: vscode.TextEditor | undefined) {
    if (!editor || editor.document.languageId !== 'latex') {
        return;
    }

    const config = vscode.workspace.getConfiguration('tex-e2c');
    if (!config.get<boolean>('showInlineHints', true)) {
        editor.setDecorations(chineseDecorationType, []);
        editor.setDecorations(markerDecorationType, []);
        return;
    }

    // 高亮中文块
    const blocks = translator.scanChineseBlocks(editor.document);
    const chineseRanges: vscode.Range[] = blocks.map(block => 
        new vscode.Range(block.startLine, 0, block.endLine, editor.document.lineAt(block.endLine).text.length)
    );
    editor.setDecorations(chineseDecorationType, chineseRanges);

    // 高亮标记行
    const markerPrefix = translator.getMarkerPrefix();
    const markerRanges: vscode.Range[] = [];
    for (let i = 0; i < editor.document.lineCount; i++) {
        const line = editor.document.lineAt(i);
        if (line.text.trim().startsWith(markerPrefix)) {
            markerRanges.push(line.range);
        }
    }
    editor.setDecorations(markerDecorationType, markerRanges);
}

/**
 * 全文翻译命令
 */
async function translateAllCommand(force: boolean) {
    const editor = vscode.window.activeTextEditor;
    
    if (!editor || editor.document.languageId !== 'latex') {
        vscode.window.showWarningMessage('请先打开一个LaTeX文件');
        return;
    }

    // 检查API配置
    const config = vscode.workspace.getConfiguration('tex-e2c');
    const apiKey = config.get<string>('apiKey', '');

        if (!apiKey) {
            const result = await vscode.window.showWarningMessage(
            '未设置API密钥',
            '配置API'
            );
            if (result === '配置API') {
                await configureApiCommand();
        }
                return;
            }

    // 保存文件
    if (editor.document.isDirty) {
        await editor.document.save();
    }

    // 更新状态栏
    statusBarItem.text = '$(sync~spin) 翻译中...';
    statusTreeProvider.setStatus('translating');

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: force ? '强制全文翻译...' : '全文翻译...',
            cancellable: false
        }, async (progress) => {
            const result = await translator.translateDocument(editor.document, force);
            
            statusTreeProvider.setStatus('idle', result);
            updateStatusBar(editor);
            updateDecorations(editor);

            if (result.translated > 0 || result.cached > 0) {
            vscode.window.showInformationMessage(
                    `翻译完成！新翻译 ${result.translated} 条，缓存命中 ${result.cached} 条` +
                    (result.errors > 0 ? `，错误 ${result.errors} 条` : '')
                );
            } else if (result.errors > 0) {
                vscode.window.showErrorMessage(`翻译出错 ${result.errors} 条，请查看输出日志`);
                outputChannel.show();
        } else {
                vscode.window.showInformationMessage('没有检测到需要翻译的中文内容！');
                }
            });
    } catch (error) {
        statusBarItem.text = '$(error) 翻译出错';
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`翻译出错: ${errorMessage}`);
        outputChannel.appendLine(`[错误] ${errorMessage}`);
        outputChannel.show();
    }

    configTreeProvider.refresh();
    statusTreeProvider.refresh();
}

/**
 * 添加中文注释命令（英文→中文注释）
 */
async function addChineseCommentsCommand(force: boolean) {
    const editor = vscode.window.activeTextEditor;
    
    if (!editor || editor.document.languageId !== 'latex') {
        vscode.window.showWarningMessage('请先打开一个LaTeX文件');
        return;
    }

    const config = vscode.workspace.getConfiguration('tex-e2c');
    const apiKey = config.get<string>('apiKey', '');
    
    if (!apiKey) {
        const result = await vscode.window.showWarningMessage(
            '未设置API密钥',
            '配置API'
        );
        if (result === '配置API') {
            await configureApiCommand();
        }
        return;
    }

    if (editor.document.isDirty) {
        await editor.document.save();
    }

    statusBarItem.text = '$(sync~spin) 添加中文注释...';

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: force ? '强制添加中文注释...' : '添加中文注释...',
            cancellable: false
        }, async () => {
            const result = await translator.addChineseComments(editor.document, force);
            
            updateStatusBar(editor);
            updateDecorations(editor);

            if (result.translated > 0 || result.cached > 0) {
                vscode.window.showInformationMessage(
                    `完成！新翻译 ${result.translated} 条，缓存 ${result.cached} 条` +
                    (result.errors > 0 ? `，错误 ${result.errors} 条` : '')
                );
            } else if (result.errors > 0) {
                vscode.window.showErrorMessage(`出错 ${result.errors} 条，请查看输出日志`);
                outputChannel.show();
            } else {
                vscode.window.showInformationMessage('没有检测到需要添加注释的英文内容！');
            }
        });
        } catch (error) {
        statusBarItem.text = '$(error) 出错';
            const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`出错: ${errorMessage}`);
        outputChannel.appendLine(`[错误] ${errorMessage}`);
        outputChannel.show();
        }

    statusTreeProvider.refresh();
}

/**
 * 同步翻译命令（更新已标记的翻译）
 */
async function syncCommand() {
    const editor = vscode.window.activeTextEditor;
    
    if (!editor || editor.document.languageId !== 'latex') {
        vscode.window.showWarningMessage('请先打开一个LaTeX文件');
        return;
    }

    const config = vscode.workspace.getConfiguration('tex-e2c');
    const apiKey = config.get<string>('apiKey', '');
    
    if (!apiKey) {
        vscode.window.showWarningMessage('请先配置API密钥');
        return;
    }

    if (editor.document.isDirty) {
        await editor.document.save();
    }

    statusBarItem.text = '$(sync~spin) 同步中...';

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '同步翻译...',
            cancellable: false
        }, async () => {
            const result = await translator.syncDocument(editor.document);
            
            updateStatusBar(editor);
            updateDecorations(editor);

            vscode.window.showInformationMessage(
                `同步完成！更新 ${result.translated} 条，缓存 ${result.cached} 条`
            );
        });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`同步出错: ${errorMessage}`);
        }
        
        statusTreeProvider.refresh();
    }

/**
 * 翻译选中文本命令
 */
async function translateSelectionCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    
    await translator.translateSelection(editor);
    updateDecorations(editor);
    statusTreeProvider.refresh();
}

/**
 * 清除缓存命令
 */
async function clearCacheCommand() {
    const result = await vscode.window.showWarningMessage(
        '确定要清除所有翻译缓存吗？',
        { modal: true },
        '确定'
    );

    if (result === '确定') {
        await translator.clearCache();
        statusTreeProvider.refresh();
        vscode.window.showInformationMessage('翻译缓存已清除');
        updateDecorations(vscode.window.activeTextEditor);
    }
}

/**
 * 配置API命令
 */
async function configureApiCommand() {
    const config = vscode.workspace.getConfiguration('tex-e2c');
    
    // API URL
    const currentUrl = config.get<string>('apiBaseUrl', 'https://api.openai.com/v1');
    const apiBaseUrl = await vscode.window.showInputBox({
        prompt: '步骤 1/3: 输入API基础URL',
        placeHolder: 'https://api.openai.com/v1 或 https://api.deepseek.com/v1',
        value: currentUrl,
        validateInput: (value) => {
            if (!value.startsWith('http://') && !value.startsWith('https://')) {
                return 'URL必须以http://或https://开头';
            }
            return null;
        }
    });

    if (apiBaseUrl === undefined) return;
    await config.update('apiBaseUrl', apiBaseUrl, vscode.ConfigurationTarget.Global);

    // API Key
    const currentKey = config.get<string>('apiKey', '');
    const apiKey = await vscode.window.showInputBox({
        prompt: '步骤 2/3: 输入API密钥',
        password: true,
        placeHolder: 'sk-...',
        value: currentKey
    });

    if (apiKey === undefined) return;
    await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);

    // 模型
    const fetchResult = await vscode.window.showInformationMessage(
        '步骤 3/3: 选择翻译模型',
        '从API获取模型列表',
        '手动输入模型名'
    );

    if (fetchResult === '从API获取模型列表') {
        await fetchModelsCommand();
        await selectModelCommand();
    } else if (fetchResult === '手动输入模型名') {
        const model = await vscode.window.showInputBox({
            prompt: '输入模型名称',
            placeHolder: 'gpt-4o-mini',
            value: config.get<string>('model', 'gpt-4o-mini')
        });
        if (model) {
            await config.update('model', model, vscode.ConfigurationTarget.Global);
        }
    }

    vscode.window.showInformationMessage('API配置完成！');
    configTreeProvider.refresh();
}

/**
 * 获取模型列表命令
 */
async function fetchModelsCommand() {
    const config = vscode.workspace.getConfiguration('tex-e2c');
    const apiBaseUrl = config.get<string>('apiBaseUrl', '');
    const apiKey = config.get<string>('apiKey', '');

    if (!apiKey) {
        vscode.window.showWarningMessage('请先设置API密钥');
        return;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: '正在获取模型列表...',
        cancellable: false
    }, async () => {
        try {
            const models = await fetchModelsFromApi(apiBaseUrl, apiKey);
            
            if (models.length > 0) {
                await config.update('availableModels', models, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`获取到 ${models.length} 个可用模型`);
            } else {
                vscode.window.showWarningMessage('未获取到模型列表');
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`获取模型列表失败: ${errorMessage}`);
        }
    });

    configTreeProvider.refresh();
}

/**
 * 选择模型命令
 */
async function selectModelCommand() {
    const config = vscode.workspace.getConfiguration('tex-e2c');
    let models = config.get<string[]>('availableModels', []);
    
    if (models.length === 0) {
        const result = await vscode.window.showInformationMessage(
            '暂无模型列表，是否从API获取？',
            '获取',
            '手动输入'
        );
        
        if (result === '获取') {
            await fetchModelsCommand();
            models = config.get<string[]>('availableModels', []);
        } else if (result === '手动输入') {
            const model = await vscode.window.showInputBox({
                prompt: '输入模型名称',
                placeHolder: 'gpt-4o-mini'
            });
            if (model) {
                await config.update('model', model, vscode.ConfigurationTarget.Global);
                vscode.window.showInformationMessage(`已选择模型: ${model}`);
            }
            return;
        } else {
            return;
        }
    }

    if (models.length === 0) return;

    const currentModel = config.get<string>('model', 'gpt-4o-mini');

    const quickPick = vscode.window.createQuickPick();
    quickPick.title = '选择翻译模型';
    quickPick.placeholder = '搜索模型...';
    quickPick.items = models.map(model => ({
        label: model,
        description: model === currentModel ? '(当前)' : ''
    }));

    quickPick.onDidAccept(async () => {
        const selected = quickPick.selectedItems[0];
        if (selected) {
            await config.update('model', selected.label, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`已选择: ${selected.label}`);
            configTreeProvider.refresh();
        }
        quickPick.hide();
    });

    quickPick.show();
}

/**
 * 从API获取模型列表
 */
function fetchModelsFromApi(baseUrl: string, apiKey: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        let modelsUrl = baseUrl;
        if (!modelsUrl.endsWith('/')) modelsUrl += '/';
        if (!modelsUrl.endsWith('models')) modelsUrl += 'models';

        const url = new URL(modelsUrl);
        const isHttps = url.protocol === 'https:';
        const httpModule = isHttps ? https : http;

        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        };

        const req = httpModule.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        reject(new Error(`API错误 ${res.statusCode}`));
                        return;
                    }

                    const response = JSON.parse(data);
                    let models: string[] = [];

                    if (response.data && Array.isArray(response.data)) {
                        models = response.data.map((m: any) => m.id || m.name).filter(Boolean);
                    } else if (Array.isArray(response)) {
                        models = response.map((m: any) => typeof m === 'string' ? m : m.id).filter(Boolean);
                    }

                    const translationModels = models.filter(m => {
                        const lower = m.toLowerCase();
                        return lower.includes('gpt') || lower.includes('claude') || 
                               lower.includes('deepseek') || lower.includes('qwen') ||
                               lower.includes('gemini') || lower.includes('chat');
                    });

                    resolve(translationModels.length > 0 ? translationModels : models);
                } catch (e) {
                    reject(new Error(`解析响应失败: ${e}`));
                }
            });
        });

        req.on('error', (e) => reject(new Error(`请求失败: ${e.message}`)));
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('超时')); });
        req.end();
    });
}

export function deactivate() {
    console.log('TeX E2C 插件已停用');
}
