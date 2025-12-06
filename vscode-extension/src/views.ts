import * as vscode from 'vscode';
import { SyncTranslator } from './translator';

/**
 * 通用树项
 */
class TreeItem extends vscode.TreeItem {
    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
        options?: {
            icon?: string;
            description?: string;
            tooltip?: string;
            command?: vscode.Command;
        }
    ) {
        super(label, collapsibleState);
        if (options?.icon) {
            this.iconPath = new vscode.ThemeIcon(options.icon);
        }
        if (options?.description) {
            this.description = options.description;
        }
        if (options?.tooltip) {
            this.tooltip = options.tooltip;
        }
        if (options?.command) {
            this.command = options.command;
        }
    }
}

/**
 * 配置视图
 */
export class ConfigTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): Thenable<TreeItem[]> {
        const config = vscode.workspace.getConfiguration('tex-e2c');
        const items: TreeItem[] = [];

        // API URL
        const apiUrl = config.get<string>('apiBaseUrl', '未设置');
        items.push(new TreeItem('API 地址', vscode.TreeItemCollapsibleState.None, {
            icon: 'globe',
            description: this.extractHost(apiUrl),
            tooltip: `点击修改\n当前: ${apiUrl}`,
            command: { command: 'tex-e2c.configureApi', title: '配置API' }
        }));

        // API Key
        const apiKey = config.get<string>('apiKey', '');
        items.push(new TreeItem('API 密钥', vscode.TreeItemCollapsibleState.None, {
            icon: 'key',
            description: apiKey ? '✓ 已配置' : '✗ 未配置',
            tooltip: '点击配置',
            command: { command: 'tex-e2c.configureApi', title: '配置API' }
        }));

        // 模型
        const model = config.get<string>('model', 'gpt-4o-mini');
        items.push(new TreeItem('翻译模型', vscode.TreeItemCollapsibleState.None, {
            icon: 'hubot',
            description: model,
            tooltip: '点击选择模型',
            command: { command: 'tex-e2c.selectModel', title: '选择模型' }
        }));

        items.push(new TreeItem('─────────────', vscode.TreeItemCollapsibleState.None));

        // 自动翻译设置 - 点击打开设置
        const autoMode = config.get<string>('autoTranslateOnSave', 'off');
        const autoModeLabels: Record<string, string> = {
            'off': '关闭',
            'auto': '自动检测',
            'cn2en': '中文→英文',
            'en2cn': '英文→中文',
            'sync': '同步更新'
        };
        items.push(new TreeItem('Ctrl+S 自动翻译', vscode.TreeItemCollapsibleState.None, {
            icon: autoMode === 'off' ? 'circle-outline' : 'pass-filled',
            description: autoModeLabels[autoMode] || autoMode,
            tooltip: '点击打开设置',
            command: { 
                command: 'workbench.action.openSettings', 
                title: '打开设置',
                arguments: ['tex-e2c.autoTranslateOnSave']
            }
        }));

        // 快捷键说明
        items.push(new TreeItem('快捷键设置', vscode.TreeItemCollapsibleState.None, {
            icon: 'keyboard',
            description: 'Ctrl+K Ctrl+S',
            tooltip: '点击打开快捷键设置，搜索 tex-e2c 自定义快捷键',
            command: { 
                command: 'workbench.action.openGlobalKeybindings', 
                title: '打开快捷键设置',
                arguments: ['tex-e2c']
            }
        }));

        return Promise.resolve(items);
    }

    private extractHost(url: string): string {
        try {
            return new URL(url).hostname;
        } catch {
            return url.substring(0, 20) + '...';
        }
    }
}

/**
 * 状态视图
 */
export class StatusTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private translator: SyncTranslator;
    private currentStatus: 'idle' | 'translating' = 'idle';
    private lastResult?: { translated: number; cached: number; errors: number };

    constructor(translator: SyncTranslator) {
        this.translator = translator;
    }

    setStatus(status: 'idle' | 'translating', result?: { translated: number; cached: number; errors: number }): void {
        this.currentStatus = status;
        if (result) this.lastResult = result;
        this._onDidChangeTreeData.fire();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): Thenable<TreeItem[]> {
        const items: TreeItem[] = [];
        const editor = vscode.window.activeTextEditor;

        if (!editor || editor.document.languageId !== 'latex') {
            items.push(new TreeItem('打开 LaTeX 文件以开始', vscode.TreeItemCollapsibleState.None, {
                icon: 'info'
            }));
            return Promise.resolve(items);
        }

        // 当前文件
        const fileName = editor.document.fileName.split(/[/\\]/).pop() || '';
        items.push(new TreeItem('当前文件', vscode.TreeItemCollapsibleState.None, {
            icon: 'file-text',
            description: fileName
        }));

        // 检测中文块
        const blocks = this.translator.scanChineseBlocks(editor.document);
        
        items.push(new TreeItem('─────────────', vscode.TreeItemCollapsibleState.None));

        if (blocks.length > 0) {
            items.push(new TreeItem('检测到中文', vscode.TreeItemCollapsibleState.None, {
                icon: 'warning',
                description: `${blocks.length} 处待翻译`
            }));
        } else {
            items.push(new TreeItem('翻译状态', vscode.TreeItemCollapsibleState.None, {
                icon: 'pass-filled',
                description: '已全部翻译 ✓'
            }));
        }

        // 缓存统计
        const cacheStats = this.translator.getCacheStats();
        items.push(new TreeItem('翻译缓存', vscode.TreeItemCollapsibleState.None, {
            icon: 'database',
            description: `${cacheStats.entries} 条`
        }));

        // 上次结果
        if (this.lastResult) {
            items.push(new TreeItem('─────────────', vscode.TreeItemCollapsibleState.None));
            items.push(new TreeItem('上次翻译', vscode.TreeItemCollapsibleState.None, {
                icon: 'history',
                description: `新 ${this.lastResult.translated}，缓存 ${this.lastResult.cached}`
            }));
        }

        return Promise.resolve(items);
    }
}

/**
 * 操作视图
 */
export class ActionsTreeProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): Thenable<TreeItem[]> {
        const items: TreeItem[] = [];

        // ===== 中文→英文 =====
        items.push(new TreeItem('📝 中文 → 英文', vscode.TreeItemCollapsibleState.None, {
            icon: 'arrow-right'
        }));

        items.push(new TreeItem('  全文翻译', vscode.TreeItemCollapsibleState.None, {
            icon: 'globe',
            description: 'Ctrl+Alt+T',
            tooltip: '检测中文内容，翻译成英文\n中文变注释，英文变正文',
            command: { command: 'tex-e2c.translateAll', title: '全文翻译' }
        }));

        items.push(new TreeItem('  强制重新翻译', vscode.TreeItemCollapsibleState.None, {
            icon: 'refresh',
            tooltip: '忽略缓存，重新翻译所有中文',
            command: { command: 'tex-e2c.translateAllForce', title: '强制翻译' }
        }));

        items.push(new TreeItem('─────────────', vscode.TreeItemCollapsibleState.None));

        // ===== 英文→中文注释 =====
        items.push(new TreeItem('📖 英文 → 中文注释', vscode.TreeItemCollapsibleState.None, {
            icon: 'arrow-left'
        }));

        items.push(new TreeItem('  添加中文注释', vscode.TreeItemCollapsibleState.None, {
            icon: 'comment',
            tooltip: '检测英文内容，在上方添加中文注释',
            command: { command: 'tex-e2c.addChineseComments', title: '添加注释' }
        }));

        items.push(new TreeItem('  强制重新翻译', vscode.TreeItemCollapsibleState.None, {
            icon: 'comment-discussion',
            tooltip: '忽略缓存，重新翻译所有英文',
            command: { command: 'tex-e2c.addChineseCommentsForce', title: '强制添加' }
        }));

        items.push(new TreeItem('─────────────', vscode.TreeItemCollapsibleState.None));

        // ===== 同步 =====
        items.push(new TreeItem('🔄 同步更新', vscode.TreeItemCollapsibleState.None, {
            icon: 'sync',
            tooltip: '修改中文注释后，同步更新英文翻译',
            command: { command: 'tex-e2c.sync', title: '同步' }
        }));

        items.push(new TreeItem('翻译选中文本', vscode.TreeItemCollapsibleState.None, {
            icon: 'symbol-text',
            command: { command: 'tex-e2c.translateSelection', title: '翻译选中' }
        }));

        items.push(new TreeItem('─────────────', vscode.TreeItemCollapsibleState.None));

        items.push(new TreeItem('获取模型列表', vscode.TreeItemCollapsibleState.None, {
            icon: 'cloud-download',
            command: { command: 'tex-e2c.fetchModels', title: '获取模型' }
        }));

        items.push(new TreeItem('清除缓存', vscode.TreeItemCollapsibleState.None, {
            icon: 'trash',
            command: { command: 'tex-e2c.clearCache', title: '清除' }
        }));

        return Promise.resolve(items);
    }
}
