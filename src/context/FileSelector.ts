/**
 * File Selector Component
 * Supports @ triggered file selection, folder browsing, and snippet selection
 */

import { App, TFile, TFolder, TAbstractFile, MarkdownView } from 'obsidian';
import type { LLMWikiSettings, ChatContext, FileReference } from '../types';
import { estimateTokens } from './ContextManager';

/**
 * File item for display
 */
export interface FileItem {
    name: string;
    path: string;
    type: 'file' | 'folder';
    extension?: string;
    isCurrentFolder?: boolean;
}

/**
 * Parse [[file]] syntax from text
 */
export function parseFileReferences(text: string): FileReference[] {
    const references: FileReference[] = [];
    // Match [[path]] or [[path|display]]
    const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
    let match;
    
    while ((match = regex.exec(text)) !== null) {
        references.push({
            path: match[1].trim(),
            displayName: match[2]?.trim(),
            fullMatch: match[0]
        });
    }
    
    return references;
}

/**
 * Create Obsidian internal link
 */
export function createInternalLink(path: string, displayName?: string): string {
    if (displayName) {
        return `[[${path}|${displayName}]]`;
    }
    return `[[${path}]]`;
}

/**
 * Get files in current folder (where active file is located)
 */
export function getCurrentFolderFiles(app: App): FileItem[] {
    const items: FileItem[] = [];
    const activeFile = app.workspace.getActiveFile();
    
    if (activeFile) {
        const parent = activeFile.parent;
        if (parent) {
            // Add parent folder indicator
            items.push({
                name: `📁 .. (${parent.parent?.name || 'root'})`,
                path: parent.parent?.path || '/',
                type: 'folder',
                isCurrentFolder: false
            });
            
            // Add items in current folder
            parent.children.forEach(child => {
                if (child instanceof TFile) {
                    items.push({
                        name: child.name,
                        path: child.path,
                        type: 'file',
                        extension: child.extension
                    });
                } else if (child instanceof TFolder) {
                    items.push({
                        name: `📁 ${child.name}`,
                        path: child.path,
                        type: 'folder'
                    });
                }
            });
        }
    } else {
        // No active file, show vault root
        const root = app.vault.getRoot();
        root.children.forEach(child => {
            if (child instanceof TFile) {
                items.push({
                    name: child.name,
                    path: child.path,
                    type: 'file',
                    extension: child.extension
                });
            } else if (child instanceof TFolder) {
                items.push({
                    name: `📁 ${child.name}`,
                    path: child.path,
                    type: 'folder'
                });
            }
        });
    }
    
    return items;
}

/**
 * Get files in a specific folder
 */
export function getFolderFiles(app: App, folderPath: string): FileItem[] {
    const items: FileItem[] = [];
    
    if (folderPath === '/' || folderPath === '') {
        const root = app.vault.getRoot();
        items.push({
            name: '📁 / (root)',
            path: '/',
            type: 'folder',
            isCurrentFolder: true
        });
        
        root.children.forEach(child => {
            if (child instanceof TFile) {
                items.push({
                    name: child.name,
                    path: child.path,
                    type: 'file',
                    extension: child.extension
                });
            } else if (child instanceof TFolder) {
                items.push({
                    name: `📁 ${child.name}`,
                    path: child.path,
                    type: 'folder'
                });
            }
        });
    } else {
        const folder = app.vault.getAbstractFileByPath(folderPath);
        
        if (folder instanceof TFolder) {
            // Add parent folder
            if (folder.parent) {
                items.push({
                    name: `📁 .. (${folder.parent.path || 'root'})`,
                    path: folder.parent.path || '/',
                    type: 'folder',
                    isCurrentFolder: false
                });
            }
            
            // Add current folder indicator
            items.push({
                name: `📁 ${folder.path}`,
                path: folder.path,
                type: 'folder',
                isCurrentFolder: true
            });
            
            // Add items in folder
            folder.children.forEach(child => {
                if (child instanceof TFile) {
                    items.push({
                        name: child.name,
                        path: child.path,
                        type: 'file',
                        extension: child.extension
                    });
                } else if (child instanceof TFolder) {
                    items.push({
                        name: `📁 ${child.name}`,
                        path: child.path,
                        type: 'folder'
                    });
                }
            });
        }
    }
    
    return items;
}

/**
 * Search files by name
 */
export function searchFiles(app: App, query: string, maxResults: number = 20): FileItem[] {
    const items: FileItem[] = [];
    const lowerQuery = query.toLowerCase();
    
    app.vault.getFiles().forEach(file => {
        if (file.name.toLowerCase().includes(lowerQuery) || 
            file.path.toLowerCase().includes(lowerQuery)) {
            items.push({
                name: file.name,
                path: file.path,
                type: 'file',
                extension: file.extension
            });
        }
    });
    
    return items.slice(0, maxResults);
}

/**
 * Add file as context with link
 */
export async function addFileWithContext(
    app: App, 
    filePath: string
): Promise<ChatContext | null> {
    try {
        const file = app.vault.getAbstractFileByPath(filePath);
        
        if (file instanceof TFile) {
            const content = await app.vault.read(file);
            const tokens = estimateTokens(content);
            const link = createInternalLink(file.path, file.basename);
            
            return {
                id: `file-${file.path}-${Date.now()}`,
                type: 'file',
                name: file.name,
                path: file.path,
                content: content,
                tokens: tokens,
                link: link
            };
        }
        
        return null;
    } catch (error) {
        console.error('Failed to add file context:', error);
        return null;
    }
}

/**
 * Add file snippet as context
 */
export async function addSnippetContext(
    app: App,
    filePath: string,
    startLine: number,
    endLine: number,
    selectedText?: string
): Promise<ChatContext | null> {
    try {
        const file = app.vault.getAbstractFileByPath(filePath);
        
        if (file instanceof TFile) {
            const fullContent = await app.vault.read(file);
            const lines = fullContent.split('\n');
            
            // Validate line range
            const validStart = Math.max(1, Math.min(startLine, lines.length));
            const validEnd = Math.max(validStart, Math.min(endLine, lines.length));
            
            // Extract snippet (convert to 0-based index)
            const snippetLines = lines.slice(validStart - 1, validEnd);
            const snippetContent = snippetLines.join('\n');
            
            const tokens = estimateTokens(snippetContent);
            const link = createInternalLink(file.path, `${file.basename}:L${validStart}-L${validEnd}`);
            
            return {
                id: `snippet-${file.path}-L${validStart}-L${validEnd}-${Date.now()}`,
                type: 'snippet',
                name: `${file.basename} (L${validStart}-L${validEnd})`,
                path: file.path,
                content: snippetContent,
                tokens: tokens,
                link: link,
                startLine: validStart,
                endLine: validEnd
            };
        }
        
        return null;
    } catch (error) {
        console.error('Failed to add snippet context:', error);
        return null;
    }
}

/**
 * Add current selection as context
 * This is used when user has selected text in the editor
 */
export async function addSelectionAsContext(
    app: App
): Promise<ChatContext | null> {
    try {
        const activeFile = app.workspace.getActiveFile();
        const view = app.workspace.getActiveViewOfType(MarkdownView);
        
        if (!activeFile || !view) {
            return null;
        }
        
        // Try to get selection from editor
        const editor = (view as any).editor;
        if (!editor) {
            return null;
        }
        
        const selection = editor.getSelection();
        if (!selection || selection.length === 0) {
            return null;
        }
        
        // Get line numbers
        const from = editor.getCursor('from');
        const to = editor.getCursor('to');
        const startLine = from.line + 1; // Convert to 1-based
        const endLine = to.line + 1;
        
        const tokens = estimateTokens(selection);
        const link = createInternalLink(
            activeFile.path, 
            `${activeFile.basename}:L${startLine}-L${endLine}`
        );
        
        return {
            id: `snippet-${activeFile.path}-L${startLine}-L${endLine}-${Date.now()}`,
            type: 'snippet',
            name: `${activeFile.basename} (L${startLine}-L${endLine})`,
            path: activeFile.path,
            content: selection,
            tokens: tokens,
            link: link,
            startLine: startLine,
            endLine: endLine
        };
    } catch (error) {
        console.error('Failed to add selection as context:', error);
        return null;
    }
}

/**
 * File Selector UI Component
 */
export class FileSelector {
    private app: App;
    private containerEl: HTMLElement;
    private onSelect: (item: FileItem) => void;
    private onSnippetSelect?: (filePath: string, startLine: number, endLine: number) => void;
    private currentPath: string = '';
    private filterText: string = '';
    private items: FileItem[] = [];
    private selectedIndex: number = 0;

    constructor(
        app: App,
        containerEl: HTMLElement,
        onSelect: (item: FileItem) => void,
        onSnippetSelect?: (filePath: string, startLine: number, endLine: number) => void
    ) {
        this.app = app;
        this.containerEl = containerEl;
        this.onSelect = onSelect;
        this.onSnippetSelect = onSnippetSelect;
    }

    /**
     * Show the file selector
     */
    show(triggerChar: string = '@'): void {
        this.containerEl.empty();
        this.containerEl.removeClass('hidden');
        this.containerEl.addClass('file-selector');
        
        // Get initial files from current folder
        this.items = getCurrentFolderFiles(this.app);
        this.selectedIndex = 0;
        
        this.render();
    }

    /**
     * Hide the file selector
     */
    hide(): void {
        this.containerEl.addClass('hidden');
        this.containerEl.empty();
    }

    /**
     * Check if visible
     */
    isVisible(): boolean {
        return !this.containerEl.hasClass('hidden');
    }

    /**
     * Set filter text
     */
    setFilter(text: string): void {
        this.filterText = text;
        
        if (text.length > 0) {
            // Search mode
            this.items = searchFiles(this.app, text);
        } else {
            // Browse mode
            this.items = getFolderFiles(this.app, this.currentPath);
        }
        
        this.selectedIndex = 0;
        this.render();
    }

    /**
     * Navigate to folder
     */
    navigateToFolder(path: string): void {
        this.currentPath = path;
        this.items = getFolderFiles(this.app, path);
        this.selectedIndex = 0;
        this.render();
    }

    /**
     * Move selection up
     */
    selectPrevious(): void {
        if (this.selectedIndex > 0) {
            this.selectedIndex--;
            this.render();
        }
    }

    /**
     * Move selection down
     */
    selectNext(): void {
        if (this.selectedIndex < this.items.length - 1) {
            this.selectedIndex++;
            this.render();
        }
    }

    /**
     * Confirm current selection
     */
    confirmSelection(): void {
        if (this.items.length > 0 && this.selectedIndex >= 0) {
            const item = this.items[this.selectedIndex];
            if (item.type === 'folder') {
                this.navigateToFolder(item.path);
            } else {
                this.onSelect(item);
            }
        }
    }

    /**
     * Render the selector
     */
    private render(): void {
        this.containerEl.empty();
        
        // Header with current path
        const header = this.containerEl.createDiv({ cls: 'file-selector-header' });
        const pathText = this.currentPath || 'Current Folder';
        header.createSpan({ text: `📂 ${pathText}`, cls: 'file-selector-path' });
        
        if (this.filterText) {
            const filterEl = header.createSpan({ cls: 'file-selector-filter' });
            filterEl.setText(`Search: "${this.filterText}"`);
        }
        
        // File list
        const listEl = this.containerEl.createDiv({ cls: 'file-selector-list' });
        
        if (this.items.length === 0) {
            const empty = listEl.createDiv({ cls: 'file-selector-empty' });
            empty.setText('No files found');
            return;
        }
        
        this.items.forEach((item, index) => {
            const itemEl = listEl.createDiv({ 
                cls: `file-selector-item ${index === this.selectedIndex ? 'selected' : ''} ${item.type}`
            });
            
            // Icon
            const icon = item.type === 'folder' ? '📁' : this.getFileIcon(item.extension || '');
            itemEl.createSpan({ text: icon, cls: 'file-selector-icon' });
            
            // Name
            itemEl.createSpan({ text: item.name, cls: 'file-selector-name' });
            
            // Path hint
            if (item.type === 'file') {
                const pathHint = itemEl.createSpan({ cls: 'file-selector-path-hint' });
                pathHint.setText(item.path);
            }
            
            // Click handler
            itemEl.onClickEvent(() => {
                this.selectedIndex = index;
                if (item.type === 'folder') {
                    this.navigateToFolder(item.path);
                } else {
                    this.onSelect(item);
                }
            });
        });
        
        // Footer hint
        const footer = this.containerEl.createDiv({ cls: 'file-selector-footer' });
        footer.createSpan({ text: '↑↓ Navigate · Enter Select · Esc Close', cls: 'file-selector-hint' });
    }

    /**
     * Get icon for file type
     */
    private getFileIcon(extension: string): string {
        const icons: Record<string, string> = {
            'md': '📝',
            'txt': '📄',
            'json': '📋',
            'js': '📜',
            'ts': '📜',
            'css': '🎨',
            'html': '🌐',
            'png': '🖼️',
            'jpg': '🖼️',
            'jpeg': '🖼️',
            'gif': '🖼️',
            'pdf': '📕',
        };
        return icons[extension.toLowerCase()] || '📄';
    }
}

/**
 * Snippet Selector for selecting text range in a file
 */
export class SnippetSelector {
    private app: App;
    private containerEl: HTMLElement;
    private filePath: string;
    private content: string;
    private lines: string[];
    private startLine: number = 1;
    private endLine: number = 1;
    private onConfirm: (filePath: string, startLine: number, endLine: number) => void;

    constructor(
        app: App,
        containerEl: HTMLElement,
        filePath: string,
        content: string,
        onConfirm: (filePath: string, startLine: number, endLine: number) => void
    ) {
        this.app = app;
        this.containerEl = containerEl;
        this.filePath = filePath;
        this.content = content;
        this.lines = content.split('\n');
        this.endLine = Math.min(20, this.lines.length); // Default show first 20 lines
        this.onConfirm = onConfirm;
    }

    /**
     * Show the snippet selector
     */
    show(): void {
        this.containerEl.empty();
        this.containerEl.removeClass('hidden');
        this.containerEl.addClass('snippet-selector');
        this.render();
    }

    /**
     * Hide the snippet selector
     */
    hide(): void {
        this.containerEl.addClass('hidden');
        this.containerEl.empty();
    }

    /**
     * Set start line
     */
    setStartLine(line: number): void {
        this.startLine = Math.max(1, Math.min(line, this.lines.length));
        if (this.startLine > this.endLine) {
            this.endLine = this.startLine;
        }
        this.render();
    }

    /**
     * Set end line
     */
    setEndLine(line: number): void {
        this.endLine = Math.max(this.startLine, Math.min(line, this.lines.length));
        this.render();
    }

    /**
     * Confirm selection
     */
    confirm(): void {
        this.onConfirm(this.filePath, this.startLine, this.endLine);
    }

    /**
     * Render the snippet selector
     */
    private render(): void {
        this.containerEl.empty();
        
        // Header
        const header = this.containerEl.createDiv({ cls: 'snippet-selector-header' });
        header.createSpan({ text: `Select Lines: ${this.startLine} - ${this.endLine}` });
        
        // Line range inputs
        const rangeEl = this.containerEl.createDiv({ cls: 'snippet-selector-range' });
        
        const startInput = rangeEl.createEl('input', {
            attr: {
                type: 'number',
                min: '1',
                max: String(this.lines.length),
                value: String(this.startLine)
            },
            cls: 'snippet-range-input'
        });
        startInput.addEventListener('change', () => {
            this.setStartLine(parseInt(startInput.value) || 1);
        });
        
        rangeEl.createSpan({ text: ' - ' });
        
        const endInput = rangeEl.createEl('input', {
            attr: {
                type: 'number',
                min: '1',
                max: String(this.lines.length),
                value: String(this.endLine)
            },
            cls: 'snippet-range-input'
        });
        endInput.addEventListener('change', () => {
            this.setEndLine(parseInt(endInput.value) || 1);
        });
        
        // Preview
        const previewEl = this.containerEl.createDiv({ cls: 'snippet-selector-preview' });
        
        for (let i = this.startLine - 1; i < this.endLine && i < this.lines.length; i++) {
            const lineEl = previewEl.createDiv({ cls: 'snippet-line' });
            const lineNum = lineEl.createSpan({ cls: 'snippet-line-num' });
            lineNum.setText(String(i + 1));
            lineEl.createSpan({ text: this.lines[i], cls: 'snippet-line-content' });
        }
        
        // Actions
        const actionsEl = this.containerEl.createDiv({ cls: 'snippet-selector-actions' });
        
        actionsEl.createEl('button', { text: 'Cancel', cls: 'snippet-btn snippet-btn-cancel' })
            .onClickEvent(() => this.hide());
        
        actionsEl.createEl('button', { text: 'Add to Context', cls: 'snippet-btn snippet-btn-confirm' })
            .onClickEvent(() => this.confirm());
    }
}