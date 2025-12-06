import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as https from 'https';
import * as http from 'http';

/**
 * 中文文本块
 */
export interface ChineseBlock {
    /** 起始行号 (0-based) */
    startLine: number;
    /** 结束行号 (0-based) */
    endLine: number;
    /** 中文原文 */
    text: string;
    /** 原始行内容（保留缩进等） */
    originalLines: string[];
    /** hash */
    hash: string;
}

/**
 * 翻译缓存条目
 */
interface CacheEntry {
    cnText: string;
    enText: string;
    model: string;
    timestamp: number;
}

/**
 * 翻译缓存
 */
interface TranslationCache {
    [hash: string]: CacheEntry;
}

/**
 * 同步翻译器 - 核心类
 */
export class SyncTranslator {
    private context: vscode.ExtensionContext;
    private outputChannel: vscode.OutputChannel;
    private cache: TranslationCache = {};
    private cacheKey = 'tex-e2c.translationCache';

    constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
        this.context = context;
        this.outputChannel = outputChannel;
        this.loadCache();
    }

    /**
     * 获取标记前缀
     */
    getMarkerPrefix(): string {
        const config = vscode.workspace.getConfiguration('tex-e2c');
        return config.get<string>('markerPrefix', '% @cn:');
    }

    /**
     * 计算文本hash
     */
    private computeHash(text: string): string {
        return crypto.createHash('md5').update(text.trim()).digest('hex').substring(0, 12);
    }

    /**
     * 加载缓存
     */
    private loadCache(): void {
        this.cache = this.context.globalState.get<TranslationCache>(this.cacheKey, {});
        this.outputChannel.appendLine(`[缓存] 已加载 ${Object.keys(this.cache).length} 条翻译缓存`);
    }

    /**
     * 保存缓存
     */
    private async saveCache(): Promise<void> {
        await this.context.globalState.update(this.cacheKey, this.cache);
    }

    /**
     * 清除缓存
     */
    async clearCache(): Promise<void> {
        this.cache = {};
        await this.saveCache();
        this.outputChannel.appendLine('[缓存] 已清除所有翻译缓存');
    }

    /**
     * 获取缓存统计
     */
    getCacheStats(): { entries: number; totalChars: number } {
        const entries = Object.keys(this.cache).length;
        let totalChars = 0;
        for (const entry of Object.values(this.cache)) {
            totalChars += entry.cnText.length + entry.enText.length;
        }
        return { entries, totalChars };
    }

    /**
     * 检测文本是否包含中文
     */
    containsChinese(text: string): boolean {
        // 匹配中文字符（不包括标点）
        return /[\u4e00-\u9fa5]/.test(text);
    }

    /**
     * 检测一行是否是LaTeX结构命令（不需要翻译）
     */
    private isLatexCommandOnly(line: string): boolean {
        const trimmed = line.trim();
        // 纯结构命令，不需要翻译
        const commandOnlyPatterns = [
            /^\\documentclass(\[.*?\])?\{.*?\}$/,      // \documentclass
            /^\\usepackage(\[.*?\])?\{.*?\}$/,         // \usepackage
            /^\\geometry\{.*?\}$/,                      // \geometry
            /^\\begin\{[^}]+\}$/,                       // \begin{...}
            /^\\end\{[^}]+\}$/,                         // \end{...}
            /^\\(hline|cline|toprule|midrule|bottomrule|centering|raggedright|raggedleft)$/,
            /^\\item\s*$/,                              // 空的\item
            /^\\\\$/,                                   // 换行
            /^%.*$/,                                    // 注释行
            /^\\(maketitle|tableofcontents|newpage|clearpage|pagebreak)$/,
            /^\\(label|ref|cite|eqref)\{.*?\}$/,       // 引用命令
            /^\\(vspace|hspace|vskip|hskip)(\*)?(\{.*?\}|\[.*?\])?$/,
            /^\\(setlength|setcounter)\{.*?\}\{.*?\}$/,
            /^\\(includegraphics)(\[.*?\])?\{.*?\}$/,  // 图片（路径不翻译）
            /^\\(bibliography|bibliographystyle)\{.*?\}$/,
            /^$/,                                       // 空行
        ];
        return commandOnlyPatterns.some(p => p.test(trimmed));
    }

    /**
     * 检测一行是否是纯LaTeX命令（整行都是命令，没有需要翻译的文本）
     */
    isStructuralLine(line: string): boolean {
        const trimmed = line.trim();
        if (!trimmed) return true;
        if (trimmed.startsWith('%')) return true;
        
        // 检查是否是结构性命令
        const structuralPatterns = [
            /^\\documentclass/,
            /^\\usepackage/,
            /^\\geometry\{/,
            /^\\begin\{/,
            /^\\end\{/,
            /^\\maketitle$/,
            /^\\tableofcontents$/,
            /^\\label\{/,
            /^\\ref\{/,
            /^\\cite\{/,
            /^\\includegraphics/,
            /^\\centering$/,
            /^\\hline$/,
            /^\\\\$/,
            /^\\(vspace|hspace)/,
            /^\\(setlength|setcounter)/,
            /^\\date\{\\today\}$/,
        ];
        
        return structuralPatterns.some(p => p.test(trimmed));
    }

    /**
     * 检测一行是否已经是中文标记行
     */
    private isChineseMarkerLine(line: string): boolean {
        return line.trim().startsWith(this.getMarkerPrefix());
    }

    /**
     * 扫描文档，找出所有包含中文的文本块（排除结构性命令）
     */
    scanChineseBlocks(document: vscode.TextDocument): ChineseBlock[] {
        const blocks: ChineseBlock[] = [];
        const lines = document.getText().split('\n');
        const markerPrefix = this.getMarkerPrefix();

        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            
            // 跳过已标记的中文注释行和其后的英文行
            if (this.isChineseMarkerLine(line)) {
                i += 2; // 跳过标记行和翻译行
                continue;
            }

            // 跳过纯注释行和结构性行
            if (line.trim().startsWith('%') || this.isStructuralLine(line)) {
                i++;
                continue;
            }

            // 检测是否包含中文（且不是纯结构命令）
            if (this.containsChinese(line) && !this.isStructuralLine(line)) {
                // 只收集当前行
                const startLine = i;
                const originalLines: string[] = [line];
                const text = line.trim();
                i++;

                if (text) {
                    blocks.push({
                        startLine,
                        endLine: startLine,
                        text: text,
                        originalLines,
                        hash: this.computeHash(text)
                    });
                }
                continue;
            }

            i++;
        }

        return blocks;
    }

    /**
     * 获取待翻译的块数量
     */
    getPendingCount(document: vscode.TextDocument): number {
        const blocks = this.scanChineseBlocks(document);
        return blocks.filter(b => !this.cache[b.hash]).length;
    }

    /**
     * 全文翻译：将所有中文翻译成英文
     * 中文变成注释，英文变成正文
     * 每行中文对应一行英文，方便对照
     */
    async translateDocument(document: vscode.TextDocument, force: boolean = false): Promise<{
        translated: number;
        cached: number;
        errors: number;
    }> {
        const blocks = this.scanChineseBlocks(document);
        const config = vscode.workspace.getConfiguration('tex-e2c');
        const markerPrefix = this.getMarkerPrefix();

        if (blocks.length === 0) {
            this.outputChannel.appendLine('[翻译] 没有检测到需要翻译的中文内容');
            return { translated: 0, cached: 0, errors: 0 };
        }

        this.outputChannel.appendLine(`[翻译] 检测到 ${blocks.length} 个中文文本块`);

        let translated = 0;
        let cached = 0;
        let errors = 0;

        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === document.uri.toString()
        );

        if (!editor) {
            throw new Error('找不到对应的编辑器');
        }

        // 从后往前处理，避免行号变化影响
        const sortedBlocks = [...blocks].sort((a, b) => b.startLine - a.startLine);

        for (const block of sortedBlocks) {
            // 逐行翻译，每行中文对应一行英文
            const newLines: string[] = [];
            
            for (const originalLine of block.originalLines) {
                const lineIndent = originalLine.match(/^(\s*)/)?.[1] || '';
                const content = originalLine.trim();
                
                if (!content || !this.containsChinese(content)) {
                    // 非中文行保持原样
                    newLines.push(originalLine);
                    continue;
                }

                const lineHash = this.computeHash(content);
                let enText: string;

                // 检查缓存
                const cachedEntry = this.cache[lineHash];
                if (cachedEntry && !force) {
                    enText = cachedEntry.enText;
                    cached++;
                } else {
                    // 调用API翻译
                    try {
                        enText = await this.translateText(content);
                        this.cache[lineHash] = {
                            cnText: content,
                            enText,
                            model: config.get<string>('model', 'gpt-4o-mini'),
                            timestamp: Date.now()
                        };
                        translated++;
                        this.outputChannel.appendLine(`[翻译] "${content.substring(0, 30)}..." → "${enText.substring(0, 30)}..."`);
                    } catch (error) {
                        this.outputChannel.appendLine(`[错误] 翻译失败: ${error}`);
                        errors++;
                        // 保留原行
                        newLines.push(originalLine);
                        continue;
                    }
                }

                // 中文注释 + 对应英文
                newLines.push(`${lineIndent}${markerPrefix} ${content}`);
                newLines.push(`${lineIndent}${enText}`);
            }

            // 应用编辑
            await editor.edit(editBuilder => {
                const startPos = new vscode.Position(block.startLine, 0);
                const endPos = new vscode.Position(block.endLine, document.lineAt(block.endLine).text.length);
                const range = new vscode.Range(startPos, endPos);
                editBuilder.replace(range, newLines.join('\n'));
            });
        }

        await this.saveCache();

        return { translated, cached, errors };
    }

    /**
     * 同步翻译：支持双向同步
     * - 修改中文注释 → 更新英文
     * - 修改英文 → 更新中文注释
     */
    async syncDocument(document: vscode.TextDocument): Promise<{
        translated: number;
        cached: number;
        errors: number;
    }> {
        const lines = document.getText().split('\n');
        const markerPrefix = this.getMarkerPrefix();
        const config = vscode.workspace.getConfiguration('tex-e2c');

        let translated = 0;
        let cached = 0;
        let errors = 0;

        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === document.uri.toString()
        );

        if (!editor) {
            throw new Error('找不到对应的编辑器');
        }

        // 找出所有翻译对
        interface TranslationPair {
            cnLineStart: number;
            cnLineEnd: number;
            cnTexts: string[];       // 中文内容（每行）
            cnFullLines: string[];   // 完整的中文行（含前缀和缩进）
            enLineStart: number;
            enLineEnd: number;
            enTexts: string[];       // 英文内容（每行）
            enFullLines: string[];   // 完整的英文行
        }
        
        const pairs: TranslationPair[] = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];
            
            if (line.trim().startsWith(markerPrefix)) {
                const cnLineStart = i;
                const cnTexts: string[] = [];
                const cnFullLines: string[] = [];
                
                while (i < lines.length && lines[i].trim().startsWith(markerPrefix)) {
                    const fullLine = lines[i];
                    const cnText = fullLine.substring(fullLine.indexOf(markerPrefix) + markerPrefix.length).trim();
                    if (cnText) {
                        cnTexts.push(cnText);
                        cnFullLines.push(fullLine);
                    }
                    i++;
                }
                const cnLineEnd = i - 1;
                
                // 收集对应的英文行（直到遇到空行或注释行）
                const enLineStart = i;
                const enTexts: string[] = [];
                const enFullLines: string[] = [];
                
                while (i < lines.length) {
                    const enLine = lines[i];
                    if (enLine.trim() === '' || enLine.trim().startsWith('%')) {
                        break;
                    }
                    enTexts.push(enLine.trim());
                    enFullLines.push(enLine);
                    i++;
                }
                const enLineEnd = i - 1;
                
                if (cnTexts.length > 0 && enTexts.length > 0) {
                    pairs.push({
                        cnLineStart,
                        cnLineEnd,
                        cnTexts,
                        cnFullLines,
                        enLineStart,
                        enLineEnd,
                        enTexts,
                        enFullLines
                    });
                }
                continue;
            }
            i++;
        }

        // 检测没有英文翻译的中文注释，自动补上翻译
        interface OrphanedCn {
            startLine: number;
            endLine: number;
            cnTexts: string[];
            indent: string;
        }
        const orphanedCnBlocks: OrphanedCn[] = [];
        
        let j = 0;
        while (j < lines.length) {
            const line = lines[j];
            if (line.trim().startsWith(markerPrefix)) {
                const cnStart = j;
                const cnTexts: string[] = [];
                const indent = line.match(/^(\s*)/)?.[1] || '';
                
                while (j < lines.length && lines[j].trim().startsWith(markerPrefix)) {
                    const cnText = lines[j].substring(lines[j].indexOf(markerPrefix) + markerPrefix.length).trim();
                    if (cnText) {
                        cnTexts.push(cnText);
                    }
                    j++;
                }
                
                // 检查下一行是否是英文
                if (j >= lines.length || lines[j].trim() === '' || lines[j].trim().startsWith('%')) {
                    // 没有对应的英文行，需要补上翻译
                    if (cnTexts.length > 0) {
                        orphanedCnBlocks.push({
                            startLine: cnStart,
                            endLine: j - 1,
                            cnTexts,
                            indent
                        });
                    }
                }
                continue;
            }
            j++;
        }

        // 从后往前处理，为孤立的中文注释补上英文翻译
        if (orphanedCnBlocks.length > 0) {
            this.outputChannel.appendLine(`[补全] 发现 ${orphanedCnBlocks.length} 处中文注释需要翻译`);
            const sortedOrphans = [...orphanedCnBlocks].sort((a, b) => b.startLine - a.startLine);
            
            for (const block of sortedOrphans) {
                const fullCnText = block.cnTexts.join(' ');
                const cnHash = this.computeHash(fullCnText);
                
                // 检查缓存
                let enText: string;
                const cachedEntry = this.cache[cnHash];
                if (cachedEntry) {
                    enText = cachedEntry.enText;
                    cached++;
                } else {
                    try {
                        enText = await this.translateText(fullCnText);
                        this.cache[cnHash] = {
                            cnText: fullCnText,
                            enText,
                            model: config.get<string>('model', 'gpt-4o-mini'),
                            timestamp: Date.now()
                        };
                        translated++;
                        this.outputChannel.appendLine(`[补全翻译] "${fullCnText.substring(0, 30)}..." → "${enText.substring(0, 30)}..."`);
                    } catch (error) {
                        this.outputChannel.appendLine(`[错误] 翻译失败: ${error}`);
                        errors++;
                        continue;
                    }
                }
                
                // 在中文注释后插入英文翻译
                await editor.edit(editBuilder => {
                    const insertPos = new vscode.Position(block.endLine + 1, 0);
                    editBuilder.insert(insertPos, `${block.indent}${enText}\n`);
                });
            }
            
            await this.saveCache();
            return { translated, cached, errors };
        }

        // 从后往前处理，避免行号变化
        const sortedPairs = [...pairs].sort((a, b) => b.cnLineStart - a.cnLineStart);

        for (const pair of sortedPairs) {
            const fullCnText = pair.cnTexts.join(' ');
            const fullEnText = pair.enTexts.join(' ');
            const cnHash = this.computeHash(fullCnText);
            const enHash = this.computeHash(fullEnText);
            const cachedEntry = this.cache[cnHash];

            // 获取缩进
            const cnIndent = pair.cnFullLines[0]?.match(/^(\s*)/)?.[1] || '';
            const enIndent = pair.enFullLines[0]?.match(/^(\s*)/)?.[1] || '';

            if (cachedEntry) {
                const cachedEnHash = this.computeHash(cachedEntry.enText);
                
                if (cachedEnHash === enHash) {
                    // 中文和英文都没变
                    cached++;
                    continue;
                }
                
                // 英文被修改了 → 反向翻译更新中文注释
                this.outputChannel.appendLine(`[检测] 英文被修改，反向翻译更新中文...`);
                try {
                    const newCnText = await this.translateToChineseText(fullEnText);
                    
                    // 更新中文注释行（替换为单行）
                    await editor.edit(editBuilder => {
                        const startPos = new vscode.Position(pair.cnLineStart, 0);
                        const endPos = new vscode.Position(pair.cnLineEnd, lines[pair.cnLineEnd].length);
                        editBuilder.replace(
                            new vscode.Range(startPos, endPos), 
                            `${cnIndent}${markerPrefix} ${newCnText}`
                        );
                    });
                    
                    // 更新缓存
                    const newCnHash = this.computeHash(newCnText);
                    this.cache[newCnHash] = {
                        cnText: newCnText,
                        enText: fullEnText,
                        model: config.get<string>('model', 'gpt-4o-mini'),
                        timestamp: Date.now()
                    };
                    
                    translated++;
                    this.outputChannel.appendLine(`[反向同步] "${fullEnText.substring(0, 30)}..." → "${newCnText.substring(0, 30)}..."`);
                } catch (error) {
                    this.outputChannel.appendLine(`[错误] 反向翻译失败: ${error}`);
                    errors++;
                }
            } else {
                // 新的中文内容，需要翻译成英文
                try {
                    const enText = await this.translateText(fullCnText);
                    this.cache[cnHash] = {
                        cnText: fullCnText,
                        enText,
                        model: config.get<string>('model', 'gpt-4o-mini'),
                        timestamp: Date.now()
                    };

                    // 替换英文行
                    await editor.edit(editBuilder => {
                        const startPos = new vscode.Position(pair.enLineStart, 0);
                        const endPos = new vscode.Position(pair.enLineEnd, lines[pair.enLineEnd].length);
                        editBuilder.replace(new vscode.Range(startPos, endPos), enIndent + enText);
                    });
                    translated++;
                    this.outputChannel.appendLine(`[同步] "${fullCnText.substring(0, 30)}..." → "${enText.substring(0, 30)}..."`);
                } catch (error) {
                    this.outputChannel.appendLine(`[错误] 翻译失败: ${error}`);
                    errors++;
                }
            }
        }

        await this.saveCache();

        return { translated, cached, errors };
    }

    /**
     * 翻译单个文本
     */
    private async translateText(text: string): Promise<string> {
        const config = vscode.workspace.getConfiguration('tex-e2c');
        const apiBaseUrl = config.get<string>('apiBaseUrl', 'https://api.openai.com/v1');
        const apiKey = config.get<string>('apiKey', '');
        const model = config.get<string>('model', 'gpt-4o-mini');

        if (!apiKey) {
            throw new Error('未设置API密钥');
        }

        return this.callTranslationApi(text, apiBaseUrl, apiKey, model);
    }

    /**
     * 调用翻译API
     */
    private callTranslationApi(text: string, baseUrl: string, apiKey: string, model: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const prompt = `You are a professional academic translator. Translate the following Chinese LaTeX content to English.

IMPORTANT RULES:
1. Keep ALL LaTeX commands unchanged (like \\section, \\cite, \\ref, \\begin, \\end, etc.)
2. Keep ALL math formulas unchanged
3. Keep ALL labels and references unchanged
4. ONLY translate the Chinese text to English
5. Output ONLY the translated result, no explanations
6. Maintain the same structure and formatting

Chinese text to translate:
${text}`;

            const requestBody = JSON.stringify({
                model,
                messages: [
                    { role: 'user', content: prompt }
                ],
                temperature: 0.3,
                max_tokens: 4000
            });

            // 构建URL
            let chatUrl = baseUrl;
            if (!chatUrl.endsWith('/')) chatUrl += '/';
            if (!chatUrl.includes('chat/completions')) chatUrl += 'chat/completions';

            const url = new URL(chatUrl);
            const isHttps = url.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody)
                }
            };

            const req = httpModule.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => { data += chunk; });

                res.on('end', () => {
                    try {
                        if (res.statusCode !== 200) {
                            reject(new Error(`API错误 ${res.statusCode}: ${data}`));
                            return;
                        }

                        const response = JSON.parse(data);
                        const content = response.choices?.[0]?.message?.content?.trim();
                        
                        if (content) {
                            resolve(content);
                        } else {
                            reject(new Error('API返回空内容'));
                        }
                    } catch (e) {
                        reject(new Error(`解析响应失败: ${e}`));
                    }
                });
            });

            req.on('error', (e) => reject(new Error(`请求失败: ${e.message}`)));
            req.setTimeout(120000, () => { req.destroy(); reject(new Error('请求超时')); });

            req.write(requestBody);
            req.end();
        });
    }

    /**
     * 检测文本是否包含英文（主要是英文）
     */
    isMainlyEnglish(text: string): boolean {
        const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
        const englishChars = (text.match(/[a-zA-Z]/g) || []).length;
        return englishChars > chineseChars * 2;
    }

    /**
     * 扫描英文文本块（用于添加中文注释）
     * 只扫描还没有中文注释的英文行，排除结构性命令
     */
    scanEnglishBlocks(document: vscode.TextDocument): ChineseBlock[] {
        const blocks: ChineseBlock[] = [];
        const lines = document.getText().split('\n');
        const markerPrefix = this.getMarkerPrefix();

        // 先标记哪些行已经有中文注释（下一行是英文）
        const hasChineseComment = new Set<number>();
        for (let i = 0; i < lines.length - 1; i++) {
            if (lines[i].trim().startsWith(markerPrefix)) {
                hasChineseComment.add(i + 1);
            }
        }

        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            
            // 跳过注释行、结构性行
            if (line.trim().startsWith('%') || this.isStructuralLine(line)) {
                i++;
                continue;
            }

            // 跳过已经有中文注释的行
            if (hasChineseComment.has(i)) {
                i++;
                continue;
            }

            // 检测是否主要是英文（且不是结构命令）
            if (this.isMainlyEnglish(line) && !this.containsChinese(line) && !this.isStructuralLine(line)) {
                const startLine = i;
                const text = line.trim();
                i++;

                if (text) {
                    blocks.push({
                        startLine,
                        endLine: startLine,
                        text: text,
                        originalLines: [line],
                        hash: this.computeHash(text)
                    });
                }
                continue;
            }

            i++;
        }

        return blocks;
    }

    /**
     * 为英文文档添加中文注释
     * 每行英文上方添加对应的中文注释
     */
    async addChineseComments(document: vscode.TextDocument, force: boolean = false): Promise<{
        translated: number;
        cached: number;
        errors: number;
    }> {
        const blocks = this.scanEnglishBlocks(document);
        const config = vscode.workspace.getConfiguration('tex-e2c');
        const markerPrefix = this.getMarkerPrefix();

        if (blocks.length === 0) {
            this.outputChannel.appendLine('[翻译] 没有检测到需要添加中文注释的英文内容');
            return { translated: 0, cached: 0, errors: 0 };
        }

        this.outputChannel.appendLine(`[翻译] 检测到 ${blocks.length} 个英文文本块`);

        let translated = 0;
        let cached = 0;
        let errors = 0;

        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === document.uri.toString()
        );

        if (!editor) {
            throw new Error('找不到对应的编辑器');
        }

        // 从后往前处理
        const sortedBlocks = [...blocks].sort((a, b) => b.startLine - a.startLine);

        for (const block of sortedBlocks) {
            // 逐行翻译，每行英文上方添加对应中文注释
            const newLines: string[] = [];
            
            for (const originalLine of block.originalLines) {
                const lineIndent = originalLine.match(/^(\s*)/)?.[1] || '';
                const content = originalLine.trim();
                
                if (!content || !this.isMainlyEnglish(content)) {
                    newLines.push(originalLine);
                    continue;
                }

                let cnText: string;
                const cachedEntry = this.findReverseCacheEntry(content);
                
                if (cachedEntry && !force) {
                    cnText = cachedEntry;
                    cached++;
                } else {
                    try {
                        cnText = await this.translateToChineseText(content);
                        translated++;
                        this.outputChannel.appendLine(`[翻译] "${content.substring(0, 30)}..." → "${cnText.substring(0, 30)}..."`);
                    } catch (error) {
                        this.outputChannel.appendLine(`[错误] 翻译失败: ${error}`);
                        errors++;
                        newLines.push(originalLine);
                        continue;
                    }
                }

                // 中文注释在上，英文在下
                newLines.push(`${lineIndent}${markerPrefix} ${cnText}`);
                newLines.push(originalLine);
            }

            // 应用编辑
            await editor.edit(editBuilder => {
                const startPos = new vscode.Position(block.startLine, 0);
                const endPos = new vscode.Position(block.endLine, document.lineAt(block.endLine).text.length);
                const range = new vscode.Range(startPos, endPos);
                editBuilder.replace(range, newLines.join('\n'));
            });
        }

        await this.saveCache();

        return { translated, cached, errors };
    }

    /**
     * 查找反向缓存（通过英文找中文）
     */
    private findReverseCacheEntry(enText: string): string | null {
        const normalizedEn = enText.trim().toLowerCase();
        for (const entry of Object.values(this.cache)) {
            if (entry.enText.trim().toLowerCase() === normalizedEn) {
                return entry.cnText;
            }
        }
        return null;
    }

    /**
     * 翻译英文到中文
     */
    private async translateToChineseText(text: string): Promise<string> {
        const config = vscode.workspace.getConfiguration('tex-e2c');
        const apiBaseUrl = config.get<string>('apiBaseUrl', 'https://api.openai.com/v1');
        const apiKey = config.get<string>('apiKey', '');
        const model = config.get<string>('model', 'gpt-4o-mini');

        if (!apiKey) {
            throw new Error('未设置API密钥');
        }

        return this.callTranslationApiToChinese(text, apiBaseUrl, apiKey, model);
    }

    /**
     * 调用API翻译到中文
     */
    private callTranslationApiToChinese(text: string, baseUrl: string, apiKey: string, model: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const prompt = `You are a professional academic translator. Translate the following English LaTeX content to Chinese.

IMPORTANT RULES:
1. Keep ALL LaTeX commands unchanged (like \\section, \\cite, \\ref, \\begin, \\end, etc.)
2. Keep ALL math formulas unchanged
3. Keep ALL labels and references unchanged
4. ONLY translate the English text to Chinese
5. Output ONLY the translated Chinese text, no explanations
6. Use academic Chinese style

English text to translate:
${text}`;

            const requestBody = JSON.stringify({
                model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 4000
            });

            let chatUrl = baseUrl;
            if (!chatUrl.endsWith('/')) chatUrl += '/';
            if (!chatUrl.includes('chat/completions')) chatUrl += 'chat/completions';

            const url = new URL(chatUrl);
            const isHttps = url.protocol === 'https:';
            const httpModule = isHttps ? https : http;

            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(requestBody)
                }
            };

            const req = httpModule.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        if (res.statusCode !== 200) {
                            reject(new Error(`API错误 ${res.statusCode}: ${data}`));
                            return;
                        }
                        const response = JSON.parse(data);
                        const content = response.choices?.[0]?.message?.content?.trim();
                        if (content) {
                            resolve(content);
                        } else {
                            reject(new Error('API返回空内容'));
                        }
                    } catch (e) {
                        reject(new Error(`解析响应失败: ${e}`));
                    }
                });
            });

            req.on('error', (e) => reject(new Error(`请求失败: ${e.message}`)));
            req.setTimeout(120000, () => { req.destroy(); reject(new Error('请求超时')); });
            req.write(requestBody);
            req.end();
        });
    }

    /**
     * 翻译选中的文本
     */
    async translateSelection(editor: vscode.TextEditor): Promise<void> {
        const selection = editor.selection;
        const selectedText = editor.document.getText(selection);

        if (!selectedText.trim()) {
            vscode.window.showWarningMessage('请先选择要翻译的文本');
            return;
        }

        const config = vscode.workspace.getConfiguration('tex-e2c');
        const apiKey = config.get<string>('apiKey', '');

        if (!apiKey) {
            vscode.window.showWarningMessage('请先配置API密钥');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在翻译...',
            cancellable: false
        }, async () => {
            try {
                const translated = await this.translateText(selectedText);
                const markerPrefix = this.getMarkerPrefix();
                
                // 获取选区的缩进
                const startLine = editor.document.lineAt(selection.start.line);
                const indent = startLine.text.match(/^(\s*)/)?.[1] || '';

                // 构建新内容
                const cnComment = `${indent}${markerPrefix} ${selectedText.trim()}`;
                const enText = `${indent}${translated}`;
                const newText = `${cnComment}\n${enText}`;

                await editor.edit(editBuilder => {
                    editBuilder.replace(selection, newText);
                });

                // 更新缓存
                const hash = this.computeHash(selectedText);
                this.cache[hash] = {
                    cnText: selectedText,
                    enText: translated,
                    model: config.get<string>('model', 'gpt-4o-mini'),
                    timestamp: Date.now()
                };
                await this.saveCache();

                vscode.window.showInformationMessage('翻译完成！');
            } catch (error) {
                vscode.window.showErrorMessage(`翻译失败: ${error}`);
            }
        });
    }
}
