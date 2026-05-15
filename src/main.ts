/**
 * WikiChat Plugin - Main Entry Point
 * Transforms Obsidian into an AI-driven, self-maintaining knowledge base
 */

import { Plugin, PluginSettingTab, App, Setting, WorkspaceLeaf, TFile, Notice, Modal, normalizePath, EventRef } from 'obsidian';
import type { LLMWikiSettings, LLMProvider, ModelConfig, EmbeddingModelConfig, SearchIndexStatus } from './types';
import { DEFAULT_SETTINGS, PROVIDER_CATALOG, getProviderMetadata } from './types';
import { getLLMClient, resetLLMClient } from './llm/client';
import { ingestFile, ingestContent, ingestFiles } from './flows/ingest';
import { lintWiki } from './flows/lint';
import { EnhancedChatView } from './chat/EnhancedChatView';
import { WikiSearchEngine } from './search/WikiSearchEngine';
import { rebuildGeneratedWikiIndex } from './tools/wikiTools';

// View type constant
const VIEW_TYPE_CHAT = 'llm-wiki-chat-view';

/**
 * Main Plugin Class
 */
export default class LLMWikiPlugin extends Plugin {
    settings!: LLMWikiSettings;
    /** Shared BM25 index �?built once on load, kept in-sync via vault events. */
    searchEngine!: WikiSearchEngine;
    private searchIndexStatus: SearchIndexStatus = 'idle';
    private searchIndexTask: Promise<{ pageCount: number; slices: number }> | null = null;
    private searchIndexError: string | null = null;
    private pendingModifyTimers = new Map<string, number>();
    private autoLintTimer: number | null = null;
    private isLintRunning = false;
    private autoIngestTimer: number | null = null;
    private autoIngestEventRefs: EventRef[] = [];
    private autoIngestQueue = new Set<string>();
    private isIngestRunning = false;

    private extractExtensionFromPath(path: string): string {
        const fileName = normalizePath(path).split('/').pop() || '';
        const index = fileName.lastIndexOf('.');
        if (index <= 0 || index === fileName.length - 1) {
            return '';
        }
        return fileName.slice(index + 1).toLowerCase();
    }

    private shouldAutoIngestPath(path: string, extension?: string): boolean {
        const sourcesRoot = normalizePath(this.settings.sourcesPath);
        const normalizedPath = normalizePath(path);
        const sourcePrefix = `${sourcesRoot}/`;
        const chatHistoryMetaPath = normalizePath(`${this.settings.chatHistoryPath}/history.json`);

        const normalizedSourcesRoot = sourcesRoot.toLowerCase();
        const normalizedPathLower = normalizedPath.toLowerCase();
        const sourcePrefixLower = sourcePrefix.toLowerCase();
        const chatHistoryMetaPathLower = chatHistoryMetaPath.toLowerCase();

        if (!(normalizedPathLower === normalizedSourcesRoot || normalizedPathLower.startsWith(sourcePrefixLower))) {
            return false;
        }

        // Keep chat history under Sources, but do not auto-ingest the session metadata file.
        if (normalizedPathLower === chatHistoryMetaPathLower) {
            return false;
        }

        const normalizedExtension = (extension || this.extractExtensionFromPath(normalizedPath)).toLowerCase();
        return normalizedExtension === 'md' || normalizedExtension === 'txt' || normalizedExtension === 'json';
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private async migrateSourceReferencesForRename(oldPath: string, newPath: string): Promise<void> {
        const oldWithoutExt = normalizePath(oldPath).replace(/\.md$/i, '');
        const newWithoutExt = normalizePath(newPath).replace(/\.md$/i, '');

        if (!oldWithoutExt || oldWithoutExt === newWithoutExt) {
            return;
        }

        const newAlias = newWithoutExt.split('/').pop() || newWithoutExt;
        const wikiRoot = normalizePath(this.settings.wikiPath);
        const wikiPrefix = `${wikiRoot}/`;
        const oldTargetPattern = this.escapeRegExp(oldWithoutExt);

        const linkedWithAliasPattern = new RegExp(`\\[\\[\\s*${oldTargetPattern}\\s*\\|\\s*[^\\]]+\\]\\]`, 'gi');
        const linkedWithoutAliasPattern = new RegExp(`\\[\\[\\s*${oldTargetPattern}\\s*\\]\\]`, 'gi');
        const replacement = `[[${newWithoutExt}|${newAlias}]]`;

        const wikiFiles = this.app.vault
            .getMarkdownFiles()
            .filter((file) => {
                const normalized = normalizePath(file.path);
                return normalized === wikiRoot || normalized.startsWith(wikiPrefix);
            });

        let touched = 0;

        for (const wikiFile of wikiFiles) {
            const content = await this.app.vault.read(wikiFile);
            const updated = content
                .replace(linkedWithAliasPattern, replacement)
                .replace(linkedWithoutAliasPattern, replacement);

            if (updated !== content) {
                await this.app.vault.modify(wikiFile, updated);
                touched++;
            }
        }

        if (touched > 0) {
            await this.appendAutoIngestLog(
                'info',
                `rename-migrated oldPath=${normalizePath(oldPath)} newPath=${normalizePath(newPath)} wikiFilesUpdated=${touched}`
            );
        }
    }

    private async handleSourceRename(file: TFile, oldPath: string): Promise<void> {
        const newPath = normalizePath(file.path);
        const normalizedOldPath = normalizePath(oldPath);
        const extension = file.extension.toLowerCase();

        const oldInSources = this.shouldAutoIngestPath(normalizedOldPath, extension);
        const newInSources = this.shouldAutoIngestPath(newPath, extension);

        // Rename/move inside Sources: migrate links only, do not re-ingest.
        if (oldInSources && newInSources) {
            if (normalizedOldPath.toLowerCase() !== newPath.toLowerCase()) {
                await this.migrateSourceReferencesForRename(normalizedOldPath, newPath);
                await this.appendAutoIngestLog(
                    'info',
                    `event=rename-in-sources oldPath=${normalizedOldPath} file=${newPath} action=migrate-only`
                );
            }
            return;
        }

        if (newInSources) {
            void this.appendAutoIngestLog('info', `event=rename oldPath=${normalizedOldPath} file=${newPath}`);
            this.enqueueAutoIngest(newPath);
        }
    }

    private isPathInWikiRoot(path: string): boolean {
        const wikiRoot = normalizePath(this.settings.wikiPath);
        const normalizedPath = normalizePath(path);

        const rootLower = wikiRoot.toLowerCase();
        const pathLower = normalizedPath.toLowerCase();
        return pathLower === rootLower || pathLower.startsWith(`${rootLower}/`);
    }

    private async syncWikiPageTitleOnRename(file: TFile, oldPath: string): Promise<void> {
        if (file.extension.toLowerCase() !== 'md') {
            return;
        }

        const newPath = normalizePath(file.path);
        const normalizedOldPath = normalizePath(oldPath);

        if (!this.isPathInWikiRoot(newPath) || !this.isPathInWikiRoot(normalizedOldPath)) {
            return;
        }

        const newTitle = file.basename;
        const original = await this.app.vault.read(file);

        let updated = original;
        let changed = false;

        const frontmatterMatch = updated.match(/^---\n([\s\S]*?)\n---\n?/);
        if (frontmatterMatch) {
            const fullFrontmatter = frontmatterMatch[0];
            const frontmatterBody = frontmatterMatch[1];
            const nextFrontmatterBody = frontmatterBody.replace(/^title:\s*.*$/m, `title: ${newTitle}`);
            if (nextFrontmatterBody !== frontmatterBody) {
                const normalizedFrontmatter = `---\n${nextFrontmatterBody}\n---\n`;
                updated = normalizedFrontmatter + updated.slice(fullFrontmatter.length);
                changed = true;
            }
        }

        const headingMatch = updated.match(/^(#\s+).+$/m);
        if (headingMatch) {
            const nextUpdated = updated.replace(/^(#\s+).+$/m, `$1${newTitle}`);
            if (nextUpdated !== updated) {
                updated = nextUpdated;
                changed = true;
            }
        }

        if (!changed) {
            return;
        }

        await this.app.vault.modify(file, updated);
        await this.appendAutoIngestLog(
            'info',
            `wiki-rename-title-sync oldPath=${normalizedOldPath} newPath=${newPath} newTitle=${newTitle}`
        );
    }

    async onload() {
        await this.loadSettings();

        // Register the chat view
        this.registerView(VIEW_TYPE_CHAT, (leaf) => new EnhancedChatView(leaf, this));

        // Add ribbon icon
        this.addRibbonIcon('bot', 'WikiChat', (_evt: MouseEvent) => {
            this.activateView();
        });

        // Add commands
        this.addCommand({
            id: 'open-chat',
            name: 'Open chat dialog',
            hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'l' }],
            callback: () => {
                this.activateView();
            },
        });

        this.addCommand({
            id: 'ingest-current',
            name: 'Ingest current file to Wiki',
            callback: () => {
                this.ingestCurrentFile();
            },
        });

        this.addCommand({
            id: 'ingest-clipboard',
            name: 'Ingest clipboard content to Wiki',
            callback: () => {
                this.ingestClipboard();
            },
        });

        this.addCommand({
            id: 'query',
            name: 'Query Wiki',
            callback: () => {
                this.activateView();
            },
        });

        this.addCommand({
            id: 'lint',
            name: 'Run Wiki maintenance check',
            callback: () => {
                this.runLint();
            },
        });

        this.addCommand({
            id: 'reindex',
            name: 'Rebuild Wiki index',
            callback: () => {
                this.reindexWiki();
            },
        });

        // Add settings tab
        this.addSettingTab(new LLMWikiSettingTab(this.app, this));

        // Create necessary directories
        this.initializeDirectories();

        // Initialize scheduled maintenance
        this.setupAutoLintSchedule();

        // Initialize source-file auto-ingest trigger
        this.setupAutoIngestTrigger();

        // Keep wiki page title metadata and first heading in sync with file renames.
        this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
            if (!(file instanceof TFile)) {
                return;
            }

            void this.syncWikiPageTitleOnRename(file, oldPath);
        }));

        // Build shared BM25 index (zero I/O �?uses metadataCache).
        // Kept in-sync via vault events so queryWiki can skip reading index.md.
        this.searchEngine = new WikiSearchEngine(this.app, this.settings);
        this.app.workspace.onLayoutReady(() => {
            if (this.settings.buildSearchIndexOnStartup) {
                void this.ensureSearchIndexReady('startup', {
                    rebuildGeneratedIndex: this.settings.rebuildGeneratedIndexOnStartup,
                });
            }
            this.registerEvent(this.app.vault.on('create', f => {
                if (f instanceof TFile && f.extension === 'md') {
                    this.searchEngine.onFileCreated(f);
                }
            }));
            this.registerEvent(this.app.vault.on('delete', f => {
                if (f instanceof TFile) {
                    this.clearPendingModify(f.path);
                    this.searchEngine.onFileDeleted(f.path);
                }
            }));
            this.registerEvent(this.app.vault.on('modify', f => {
                if (f instanceof TFile && f.extension === 'md') {
                    this.scheduleSearchIndexModify(f);
                }
            }));
        });

        console.log('WikiChat Plugin loaded');
    }

    getSearchIndexStatus(): SearchIndexStatus {
        return this.searchIndexStatus;
    }

    getSearchIndexStatusMessage(): string {
        if (this.searchIndexStatus === 'building') {
            return 'Search index is rebuilding; no preloaded wiki context is available yet. Use read-only tools if a specific page is needed.';
        }

        if (this.searchIndexStatus === 'error') {
            return this.searchIndexError
                ? `Search index is unavailable: ${this.searchIndexError}. Use read-only tools if a specific page is needed.`
                : 'Search index is unavailable; no preloaded wiki context is available yet. Use read-only tools if a specific page is needed.';
        }

        if (this.searchIndexStatus === 'idle') {
            return 'Search index is not ready yet; no preloaded wiki context is available yet. Use read-only tools if a specific page is needed.';
        }

        return '';
    }

    onunload() {
        for (const timer of this.pendingModifyTimers.values()) {
            window.clearTimeout(timer);
        }
        this.pendingModifyTimers.clear();

        if (this.autoLintTimer !== null) {
            window.clearInterval(this.autoLintTimer);
            this.autoLintTimer = null;
        }

        if (this.autoIngestTimer !== null) {
            window.clearTimeout(this.autoIngestTimer);
            this.autoIngestTimer = null;
        }

        for (const eventRef of this.autoIngestEventRefs) {
            this.app.vault.offref(eventRef);
        }
        this.autoIngestEventRefs = [];

        this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
        console.log('WikiChat Plugin unloaded');
    }

    private clearPendingModify(path: string) {
        const timer = this.pendingModifyTimers.get(path);
        if (timer !== undefined) {
            window.clearTimeout(timer);
            this.pendingModifyTimers.delete(path);
        }
    }

    private scheduleSearchIndexModify(file: TFile) {
        this.clearPendingModify(file.path);
        const timer = window.setTimeout(() => {
            this.pendingModifyTimers.delete(file.path);
            this.searchEngine.onFileChanged(file);
        }, 500);
        this.pendingModifyTimers.set(file.path, timer);
    }

    async ensureSearchIndexReady(
        reason: 'startup' | 'manual' | 'query',
        options: { rebuildGeneratedIndex?: boolean } = {}
    ): Promise<{ pageCount: number; slices: number }> {
        if (this.searchIndexTask) {
            if (reason === 'manual') {
                new Notice('Wiki index rebuild is already running');
            }
            return this.searchIndexTask;
        }

        this.searchIndexStatus = 'building';
        this.searchIndexError = null;

        const rebuildGeneratedIndex = options.rebuildGeneratedIndex ?? reason === 'manual';
        const notice = new Notice(
            reason === 'manual'
                ? 'Rebuilding Wiki index...'
                : 'Building Wiki search index...',
            0
        );

        this.searchIndexTask = (async () => {
            try {
                let lastSearchUpdate = 0;
                const pageCount = await this.searchEngine.rebuildInBatches(250, (indexed, total) => {
                    if (indexed === total || indexed - lastSearchUpdate >= 250) {
                        lastSearchUpdate = indexed;
                        this.updateNotice(notice, `Building Wiki search index... ${indexed}/${total}`);
                    }
                });

                let generatedIndex = { pageCount, slices: 0 };
                if (rebuildGeneratedIndex) {
                    this.updateNotice(notice, 'Rebuilding generated Wiki index...');
                    generatedIndex = await rebuildGeneratedWikiIndex(this.app, this.settings, {
                        pageYieldBatchSize: 100,
                        onProgress: (message) => this.updateNotice(notice, message),
                    });
                }

                this.searchIndexStatus = 'ready';
                this.searchIndexError = null;
                this.updateNotice(
                    notice,
                    rebuildGeneratedIndex
                        ? `Wiki index ready: ${pageCount} pages, ${generatedIndex.slices} slices`
                        : `Wiki search index ready: ${pageCount} pages`
                );
                return generatedIndex;
            } catch (error) {
                const reasonText = error instanceof Error ? error.message : String(error);
                this.searchIndexStatus = 'error';
                this.searchIndexError = reasonText;
                this.updateNotice(notice, `Wiki index rebuild failed: ${reasonText}`);
                throw error;
            } finally {
                window.setTimeout(() => notice.hide(), 2000);
                this.searchIndexTask = null;
            }
        })();

        return this.searchIndexTask;
    }

    private updateNotice(notice: Notice, message: string) {
        const noticeWithMessage = notice as Notice & {
            setMessage?: (message: string) => void;
            noticeEl?: HTMLElement;
        };

        if (typeof noticeWithMessage.setMessage === 'function') {
            noticeWithMessage.setMessage(message);
            return;
        }

        noticeWithMessage.noticeEl?.setText(message);
    }

    setupAutoLintSchedule() {
        if (this.autoLintTimer !== null) {
            window.clearInterval(this.autoLintTimer);
            this.autoLintTimer = null;
        }

        if (!this.settings.autoLint) {
            return;
        }

        const intervalMs = Math.max(1, this.settings.lintInterval) * 60 * 1000;
        this.autoLintTimer = window.setInterval(() => {
            void this.runLint('auto');
        }, intervalMs);
    }

    setupAutoIngestTrigger() {
        for (const eventRef of this.autoIngestEventRefs) {
            this.app.vault.offref(eventRef);
        }
        this.autoIngestEventRefs = [];

        if (this.autoIngestTimer !== null) {
            window.clearTimeout(this.autoIngestTimer);
            this.autoIngestTimer = null;
        }

        this.autoIngestQueue.clear();

        if (!this.settings.autoIngest) {
            void this.appendAutoIngestLog('info', 'trigger=disabled');
            return;
        }

        void this.appendAutoIngestLog(
            'info',
            `trigger=enabled sourcesPath=${normalizePath(this.settings.sourcesPath)}`
        );

        const onCandidateFile = (eventName: 'create', file: unknown) => {
            if (!(file instanceof TFile)) {
                return;
            }

            if (!this.shouldAutoIngest(file)) {
                return;
            }

            void this.appendAutoIngestLog('info', `event=${eventName} file=${file.path}`);
            this.enqueueAutoIngest(file.path);
        };

        this.autoIngestEventRefs.push(
            this.app.vault.on('create', (file) => onCandidateFile('create', file))
        );

        this.autoIngestEventRefs.push(
            this.app.vault.on('rename', (file, oldPath) => {
                if (!(file instanceof TFile)) {
                    return;
                }

                void this.handleSourceRename(file, oldPath);
            })
        );
    }

    private shouldAutoIngest(file: TFile): boolean {
        return this.shouldAutoIngestPath(file.path, file.extension);
    }

    private enqueueAutoIngest(filePath: string) {
        this.autoIngestQueue.add(filePath);
        void this.appendAutoIngestLog('info', `queue-add file=${filePath} queueSize=${this.autoIngestQueue.size}`);
        this.scheduleAutoIngestFlush();
    }

    private scheduleAutoIngestFlush(delayMs: number = 3000) {
        if (this.autoIngestTimer !== null) {
            window.clearTimeout(this.autoIngestTimer);
        }

        void this.appendAutoIngestLog('info', `flush-scheduled delayMs=${delayMs} queueSize=${this.autoIngestQueue.size}`);

        this.autoIngestTimer = window.setTimeout(() => {
            this.autoIngestTimer = null;
            void this.flushAutoIngestQueue();
        }, delayMs);
    }

    private async flushAutoIngestQueue() {
        if (this.isIngestRunning) {
            await this.appendAutoIngestLog('skipped', 'reason=ingest-running');
            this.scheduleAutoIngestFlush(2000);
            return;
        }

        const filePaths = Array.from(this.autoIngestQueue);
        if (filePaths.length === 0) {
            return;
        }

        this.autoIngestQueue.clear();
        this.isIngestRunning = true;

        try {
            new Notice(`Auto-ingest started: ${filePaths.length} file(s)`);
            await this.appendAutoIngestLog('info', `batch-start count=${filePaths.length} files=${filePaths.join('|')}`);

            const results = await ingestFiles(
                this.app,
                this.settings,
                filePaths,
                (message) => {
                    console.log('Auto-ingest:', message);
                    void this.appendAutoIngestLog('info', `progress ${message}`);
                }
            );

            const successCount = results.filter((result) => result.success).length;
            const failedCount = results.length - successCount;
            const failedDetails = results
                .filter((result) => !result.success)
                .map((result) => `${result.sourcePath}:${result.message}`)
                .join('|');

            await this.appendAutoIngestLog(
                failedCount === 0 ? 'ok' : 'error',
                `batch-end success=${successCount} failed=${failedCount}${failedDetails ? ` failedFiles=${failedDetails}` : ''}`
            );

            if (failedCount === 0) {
                new Notice(`Auto-ingest completed: ${successCount} file(s)`);
            } else {
                new Notice(`Auto-ingest completed: ${successCount} succeeded, ${failedCount} failed`);
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            console.error('Auto-ingest failed:', error);
            await this.appendAutoIngestLog('error', `batch-crash reason=${reason}`);
            new Notice(`Auto-ingest failed: ${reason}`, 6000);
        } finally {
            this.isIngestRunning = false;

            if (this.autoIngestQueue.size > 0) {
                this.scheduleAutoIngestFlush(1000);
            }
        }
    }

    private async appendAutoIngestLog(
        status: 'info' | 'ok' | 'error' | 'skipped',
        details: string
    ): Promise<void> {
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] status=${status} ${details}`;
        const logDir = normalizePath(this.settings.indexPath || 'WikiIndex');
        const logPath = normalizePath(`${logDir}/auto-ingest.log`);

        try {
            if (!this.app.vault.getAbstractFileByPath(logDir)) {
                await this.app.vault.createFolder(logDir);
            }

            const adapter = this.app.vault.adapter as unknown as {
                append?: (path: string, data: string) => Promise<void>;
            };

            if (typeof adapter.append === 'function') {
                await adapter.append(logPath, `${logLine}\n`);
                return;
            }

            const existing = this.app.vault.getAbstractFileByPath(logPath);
            if (existing instanceof TFile) {
                const current = await this.app.vault.read(existing);
                await this.app.vault.modify(existing, `${current}${logLine}\n`);
            } else {
                await this.app.vault.create(logPath, `${logLine}\n`);
            }
        } catch (error) {
            console.warn('Failed to write auto-ingest log:', error);
        }
    }

    private async appendMaintenanceLog(
        mode: 'manual' | 'auto',
        status: 'ok' | 'error' | 'skipped',
        details: string
    ): Promise<void> {
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] mode=${mode} status=${status} ${details}`;
        const logDir = normalizePath(this.settings.indexPath || 'WikiIndex');
        const logPath = normalizePath(`${logDir}/maintenance.log`);

        try {
            if (!this.app.vault.getAbstractFileByPath(logDir)) {
                await this.app.vault.createFolder(logDir);
            }

            const adapter = this.app.vault.adapter as unknown as {
                append?: (path: string, data: string) => Promise<void>;
            };

            if (typeof adapter.append === 'function') {
                await adapter.append(logPath, `${logLine}\n`);
                return;
            }

            const existing = this.app.vault.getAbstractFileByPath(logPath);
            if (existing instanceof TFile) {
                const current = await this.app.vault.read(existing);
                await this.app.vault.modify(existing, `${current}${logLine}\n`);
            } else {
                await this.app.vault.create(logPath, `${logLine}\n`);
            }
        } catch (error) {
            console.warn('Failed to write maintenance log:', error);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.syncLegacyModelFields();
    }

    async saveSettings() {
        this.syncLegacyModelFields();
        await this.saveData(this.settings);
    }

    private syncLegacyModelFields() {
        const currentModel = this.settings.models.find((model) => model.id === this.settings.currentModelId);

        this.settings.model = currentModel?.modelId || '';
        this.settings.ollamaUrl = currentModel?.baseUrl || DEFAULT_SETTINGS.ollamaUrl;
    }

    async activateView() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_CHAT);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
            }
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }

    async initializeDirectories() {
        const { vault } = this.app;
        const dirs = [
            this.settings.wikiPath,
            this.settings.sourcesPath,
            this.settings.indexPath,
        ];

        for (const dir of dirs) {
            if (!vault.getAbstractFileByPath(dir)) {
                try {
                    await vault.createFolder(dir);
                } catch (e) {
                    // Folder might already exist
                }
            }
        }
    }

    async checkLLMConnection(modelOverride?: ModelConfig) {
        try {
            const settings = modelOverride
                ? this.createHealthCheckSettings(modelOverride)
                : this.settings;
            const client = getLLMClient(settings);
            const isHealthy = await client.healthCheck();

            if (!isHealthy) {
                new Notice('⚠️ Cannot connect to the configured model provider. Please check your model settings.', 5000);
                return false;
            }

            new Notice('�?Model connection successful', 4000);
            return true;
        } catch (error) {
            console.warn('Configured LLM health check failed:', error);
            new Notice('⚠️ No valid model is configured for automatic AI tasks.', 5000);
            return false;
        } finally {
            if (modelOverride) {
                getLLMClient(this.settings);
            }
        }
    }

    private createHealthCheckSettings(modelOverride: ModelConfig): LLMWikiSettings {
        const existingIndex = this.settings.models.findIndex((model) => model.id === modelOverride.id);
        const models = [...this.settings.models];

        if (existingIndex >= 0) {
            models[existingIndex] = modelOverride;
        } else {
            models.push(modelOverride);
        }

        return {
            ...this.settings,
            models,
            currentModelId: modelOverride.id,
            model: modelOverride.modelId,
            ollamaUrl: modelOverride.baseUrl,
        };
    }

    async ingestCurrentFile() {
        if (this.isIngestRunning) {
            new Notice('Ingest is already running');
            return;
        }

        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('No file open');
            return;
        }

        this.isIngestRunning = true;

        try {
            new Notice('Starting file ingestion...');

            const result = await ingestFile(this.app, this.settings, activeFile.path, (msg) => {
                console.log('Ingest:', msg);
            });

            if (result.success) {
                new Notice(`�?Ingestion successful: ${result.entities.length} entities`);
            } else {
                new Notice(`�?Ingestion failed: ${result.message}`);
            }
        } finally {
            this.isIngestRunning = false;
        }
    }

    async ingestClipboard() {
        if (this.isIngestRunning) {
            new Notice('Ingest is already running');
            return;
        }

        const content = await navigator.clipboard.readText();
        if (!content) {
            new Notice('Clipboard is empty');
            return;
        }

        this.isIngestRunning = true;

        try {
            new Notice('Starting content ingestion...');

            const result = await ingestContent(this.app, this.settings, content, undefined, (msg) => {
                console.log('Ingest:', msg);
            });

            if (result.success) {
                new Notice(`�?Ingestion successful: ${result.entities.length} entities`);
            } else {
                new Notice(`�?Ingestion failed: ${result.message}`);
            }
        } finally {
            this.isIngestRunning = false;
        }
    }

    async runLint(mode: 'manual' | 'auto' = 'manual') {
        if (this.isLintRunning) {
            if (mode === 'manual') {
                new Notice('Maintenance check is already running');
            }
            await this.appendMaintenanceLog(mode, 'skipped', 'reason=already-running');
            return;
        }

        this.isLintRunning = true;

        try {
            if (mode === 'manual') {
                new Notice('Starting Wiki maintenance check...');
            }

            const result = await lintWiki(this.app, this.settings, true, (msg) => {
                console.log('Lint:', msg);
            });

            this.settings.lastLintTime = result.lastLintTime;
            
            // Update stale check time if it's been 30+ days since last check
            const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;
            const lastStaleCheckTime = this.settings.lastStaleCheckTime ?? 0;
            if (Date.now() - lastStaleCheckTime >= thirtyDaysInMs) {
                this.settings.lastStaleCheckTime = Date.now();
            }
            
            await this.saveSettings();

            await this.appendMaintenanceLog(
                mode,
                'ok',
                `issues=${result.issues.length} fixed=${result.fixed} lastLintTime=${result.lastLintTime}`
            );

            if (result.issues.length === 0) {
                if (mode === 'manual') {
                    new Notice('�?Wiki is in good condition, no issues found');
                }
            } else {
                new Notice(`Found ${result.issues.length} issues, fixed ${result.fixed} of them`);
            }
        } catch (error) {
            console.error('Maintenance check failed:', error);
            await this.appendMaintenanceLog(mode, 'error', `reason=${String(error)}`);
            new Notice('�?Wiki maintenance check failed');
        } finally {
            this.isLintRunning = false;
        }
    }

    async reindexWiki() {
        try {
            const result = await this.ensureSearchIndexReady('manual');
            new Notice(`Index rebuild successful: ${result.pageCount} pages`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Index rebuild failed: ${message}`);
        }
    }
}

/**
 * Settings Tab
 */
class LLMWikiSettingTab extends PluginSettingTab {
    plugin: LLMWikiPlugin;

    constructor(app: App, plugin: LLMWikiPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();
        containerEl.createEl('h2', { text: 'WikiChat Settings' });

        // Model Management
        containerEl.createEl('h3', { text: 'Model Management' });
        this.renderModelManagement(containerEl);

        // Embedding Model Management
        containerEl.createEl('h3', { text: 'Embedding Models' });
        this.renderEmbeddingModelManagement(containerEl);

        // Path Settings
        containerEl.createEl('h3', { text: 'Directory Configuration' });

        new Setting(containerEl)
            .setName('Wiki Directory')
            .setDesc('Wiki page storage directory')
            .addText((text) =>
                text
                    .setPlaceholder('Wiki')
                    .setValue(this.plugin.settings.wikiPath)
                    .onChange(async (value) => {
                        this.plugin.settings.wikiPath = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Sources Directory')
            .setDesc('Source material storage directory')
            .addText((text) =>
                text
                    .setPlaceholder('Sources')
                    .setValue(this.plugin.settings.sourcesPath)
                    .onChange(async (value) => {
                        this.plugin.settings.sourcesPath = value;
                        await this.plugin.saveSettings();
                        this.plugin.setupAutoIngestTrigger();
                    })
            );

        new Setting(containerEl)
            .setName('Index Directory')
            .setDesc('Directory for human-readable time-slice index files and operation logs')
            .addText((text) =>
                text
                    .setPlaceholder('WikiIndex')
                    .setValue(this.plugin.settings.indexPath)
                    .onChange(async (value) => {
                        this.plugin.settings.indexPath = value;
                        await this.plugin.saveSettings();
                    })
            );

        // Chat Settings
        containerEl.createEl('h3', { text: 'Chat Configuration' });

        new Setting(containerEl)
            .setName('Auto-save Chat')
            .setDesc('Automatically save chat history to Sources directory')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.autoSaveChat || false)
                    .onChange(async (value) => {
                        this.plugin.settings.autoSaveChat = value;
                        await this.plugin.saveSettings();
                    })
            );

        const contextLengthSetting = new Setting(containerEl)
            .setName('Maximum Context Length')
            .setDesc('Maximum context token count (4k - 128k)');
        
        // Add a display span for the value in 'k' format
        const valueDisplay = contextLengthSetting.controlEl.createSpan({ cls: 'context-length-display' });
        const updateDisplay = (value: number) => {
            const kValue = Math.round(value / 1024.0);
            valueDisplay.textContent = `${kValue}k`;
        };
        
        contextLengthSetting.addSlider((slider) =>
            slider
                .setLimits(4096, 131072, 1024)
                .setValue(this.plugin.settings.maxContextTokens || 8192)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxContextTokens = value;
                    updateDisplay(value);
                    await this.plugin.saveSettings();
                })
        );
        
        updateDisplay(this.plugin.settings.maxContextTokens || 8192);

        // Automation Settings
        containerEl.createEl('h3', { text: 'Automation Configuration' });

        new Setting(containerEl)
            .setName('Auto-ingest')
            .setDesc('Automatically ingest new files placed in Sources directory')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.autoIngest)
                    .onChange(async (value) => {
                        this.plugin.settings.autoIngest = value;
                        await this.plugin.saveSettings();
                        this.plugin.setupAutoIngestTrigger();
                    })
            );

        new Setting(containerEl)
            .setName('Auto-maintenance')
            .setDesc('Periodically run Wiki maintenance checks')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.autoLint)
                    .onChange(async (value) => {
                        this.plugin.settings.autoLint = value;
                        await this.plugin.saveSettings();
                        this.plugin.setupAutoLintSchedule();
                    })
            );

        new Setting(containerEl)
            .setName('Build search index on startup')
            .setDesc('Prebuild the BM25 metadata index when Obsidian starts. Disable for very large vaults; the first query will build it on demand.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.buildSearchIndexOnStartup)
                    .onChange(async (value) => {
                        this.plugin.settings.buildSearchIndexOnStartup = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Rebuild generated WikiIndex on startup')
            .setDesc('Rewrite human-readable WikiIndex slice files during startup indexing. Keep disabled for large vaults unless you need fresh index files immediately.')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.rebuildGeneratedIndexOnStartup)
                    .onChange(async (value) => {
                        this.plugin.settings.rebuildGeneratedIndexOnStartup = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Maintenance Interval')
            .setDesc('Auto maintenance check interval (minutes)')
            .addSlider((slider) =>
                slider
                    .setLimits(10, 120, 10)
                    .setValue(this.plugin.settings.lintInterval)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.lintInterval = value;
                        await this.plugin.saveSettings();
                        this.plugin.setupAutoLintSchedule();
                    })
            );
    }

    private renderEmbeddingModelManagement(containerEl: HTMLElement): void {
        new Setting(containerEl)
            .setName('Add Embedding Model')
            .setDesc('Configure a model used for semantic reranking')
            .addButton((button) =>
                button
                    .setButtonText('+ Add Embedding Model')
                    .onClick(() => {
                        new EmbeddingModelEditModal(this.app, this.plugin, null, () => this.display()).open();
                    })
            );

        const models = this.plugin.settings.embeddingModels || [];

        if (models.length > 0) {
            // Table header
            const container = containerEl.createDiv({ cls: 'model-list-container' });
            const header = container.createDiv({ cls: 'model-table-header' });
            header.createSpan({ text: 'Model Name', cls: 'model-header-name' });
            header.createSpan({ text: 'Provider', cls: 'model-header-provider' });
            header.createSpan({ text: 'Actions', cls: 'model-header-actions' });

            const tableBody = container.createDiv({ cls: 'model-table-body' });
            models.forEach(model => {
                const row = tableBody.createDiv({ cls: 'model-row' });
                row.createDiv({ cls: 'model-cell-name' }).createSpan({ text: model.name, cls: 'model-name' });
                row.createDiv({ cls: 'model-cell-provider' }).createSpan({ text: model.provider, cls: 'model-provider' });
                const actionsCell = row.createDiv({ cls: 'model-cell-actions' });

                const editBtn = actionsCell.createEl('button', { cls: 'model-icon-btn model-edit-btn', attr: { title: 'Edit' } });
                editBtn.setText('🖊');
                editBtn.onClickEvent(() => {
                    new EmbeddingModelEditModal(this.app, this.plugin, model, () => this.display()).open();
                });

                const deleteBtn = actionsCell.createEl('button', { cls: 'model-icon-btn model-delete-btn', attr: { title: 'Delete' } });
                deleteBtn.setText('🗑');
                deleteBtn.onClickEvent(async () => {
                    const idx = this.plugin.settings.embeddingModels.findIndex(m => m.id === model.id);
                    if (idx >= 0) {
                        if (this.plugin.settings.currentEmbeddingModelId === model.id) {
                            this.plugin.settings.currentEmbeddingModelId = '';
                        }
                        this.plugin.settings.embeddingModels.splice(idx, 1);
                        await this.plugin.saveSettings();
                        this.display();
                    }
                });
            });
        }

        // Current embedding model selector
        new Setting(containerEl)
            .setName('Active Embedding Model')
            .setDesc('Used for semantic reranking of BM25 results. "None" = BM25 only.')
            .addDropdown((dropdown) => {
                dropdown.addOption('', 'None (BM25 only)');
                for (const m of this.plugin.settings.embeddingModels || []) {
                    dropdown.addOption(m.id, m.name);
                }
                dropdown.setValue(this.plugin.settings.currentEmbeddingModelId || '');
                dropdown.onChange(async (value) => {
                    this.plugin.settings.currentEmbeddingModelId = value;
                    await this.plugin.saveSettings();
                });
            });
    }

    private renderModelManagement(containerEl: HTMLElement): void {
        // Add model button (moved to top, replacing Current Model dropdown)
        new Setting(containerEl)
            .setName('Add New Model')
            .setDesc('Configure a new model')
            .addButton((button) =>
                button
                    .setButtonText('+ Add Model')
                    .onClick(() => {
                        new ModelEditModal(this.app, this.plugin, null, () => this.display()).open();
                    })
            );

        // Model list table
        const modelsContainer = containerEl.createDiv({ cls: 'model-list-container' });
        
        // Table header
        const tableHeader = modelsContainer.createDiv({ cls: 'model-table-header' });
        tableHeader.createSpan({ text: 'Model Name', cls: 'model-header-name' });
        tableHeader.createSpan({ text: 'Provider', cls: 'model-header-provider' });
        tableHeader.createSpan({ text: 'Actions', cls: 'model-header-actions' });
        
        // Table body
        const tableBody = modelsContainer.createDiv({ cls: 'model-table-body' });
        
        this.plugin.settings.models.forEach(model => {
                const modelRow = tableBody.createDiv({ cls: 'model-row' });
                
                // Model name cell
                const nameCell = modelRow.createDiv({ cls: 'model-cell-name' });
                nameCell.createSpan({ text: model.name, cls: 'model-name' });
                
                // Provider cell
                const providerCell = modelRow.createDiv({ cls: 'model-cell-provider' });
                providerCell.createSpan({ text: model.provider, cls: 'model-provider' });
                
                // Actions cell
                const actionsCell = modelRow.createDiv({ cls: 'model-cell-actions' });
                
                // Edit button (icon)
                const editBtn = actionsCell.createEl('button', { cls: 'model-icon-btn model-edit-btn', attr: { title: 'Edit' } });
                editBtn.setText('🖊');
                editBtn.onClickEvent(() => {
                    new ModelEditModal(this.app, this.plugin, model, () => this.display()).open();
                });
                
                // Delete button (icon)
                const deleteBtn = actionsCell.createEl('button', { cls: 'model-icon-btn model-delete-btn', attr: { title: 'Delete' } });
                deleteBtn.setText('🗑');
                deleteBtn.onClickEvent(async () => {
                    // Remove model from list
                    const index = this.plugin.settings.models.findIndex(m => m.id === model.id);
                    if (index >= 0) {
                        const wasCurrentModel = this.plugin.settings.currentModelId === model.id;
                        this.plugin.settings.models.splice(index, 1);

                        // If selected model is deleted, fallback to first model or empty.
                        if (wasCurrentModel) {
                            const fallbackModel = this.plugin.settings.models[0];
                            this.plugin.settings.currentModelId = fallbackModel?.id || '';
                        } else if (this.plugin.settings.models.length === 0) {
                            // Keep settings consistent when the last model is removed.
                            this.plugin.settings.currentModelId = '';
                        }

                        await this.plugin.saveSettings();

                        // Sync runtime client and notify open chat views to refresh label/list.
                        getLLMClient(this.plugin.settings);
                        document.dispatchEvent(new CustomEvent('wikichat:model-updated', {
                            detail: {
                                currentModelId: this.plugin.settings.currentModelId,
                                updatedAt: Date.now(),
                            },
                        }));

                        this.display();
                    }
                });
            });

    }
}

/**
 * Model Edit Modal
 */
class ModelEditModal extends Modal {
    private plugin: LLMWikiPlugin;
    private model: ModelConfig | null;
    private onSave: () => void;
    
    // Form fields
    private nameInput!: HTMLInputElement;
    private providerSelect!: HTMLSelectElement;
    private modelIdInput!: HTMLInputElement;
    private baseUrlInput!: HTMLInputElement;
    private apiKeyInput!: HTMLInputElement;
    private contextLengthValue: number = 4096;
    private supportsTools: boolean = true;
    private maxToolIterationsInput!: HTMLInputElement;
    private maxToolCallsPerTurnInput!: HTMLInputElement;
    private maxToolWallTimeMsInput!: HTMLInputElement;
    private maxContinuationPassesInput!: HTMLInputElement;
    private maxToolResultCharsRatioInput!: HTMLInputElement;
    private historyTurnsInput!: HTMLInputElement;
    private retrievalTopNInput!: HTMLInputElement;
    private retrievalRerankTopKInput!: HTMLInputElement;

    private static readonly INPUT_STYLE = {
        width: '100%',
        boxSizing: 'border-box' as const,
    };
    
    // Dynamic elements
    private baseUrlSetting!: Setting;
    private modelIdSetting!: Setting;
    private apiKeySetting!: Setting;

    constructor(app: App, plugin: LLMWikiPlugin, model: ModelConfig | null, onSave: () => void) {
        super(app);
        this.plugin = plugin;
        this.model = model;
        this.onSave = onSave;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('model-edit-modal');

        contentEl.createEl('h2', { text: this.model ? 'Edit Model' : 'Add New Model' });

        // Name
        new Setting(contentEl)
            .setName('Display Name')
            .setDesc('Name shown in the model selector')
            .addText((text) => {
                this.nameInput = text.inputEl;
                text.setValue(this.model?.name || '');
            });

        // Provider
        new Setting(contentEl)
            .setName('Provider')
            .setDesc('LLM provider')
            .addDropdown((dropdown) => {
                for (const provider of PROVIDER_CATALOG) {
                    dropdown.addOption(provider.id, provider.displayName);
                }

                const defaultProvider = this.model?.provider || PROVIDER_CATALOG[0]?.id || 'Ollama';
                dropdown.setValue(defaultProvider);
                dropdown.onChange((value) => {
                    this.updateProviderDefaults(value);
                });
                this.providerSelect = dropdown.selectEl;
                this.providerSelect.addClass('provider-select-input');
            });

        // Model ID
        this.modelIdSetting = new Setting(contentEl)
            .setName('Model ID')
            .setDesc('Actual model identifier for API calls')
            .addText((text) => {
                this.modelIdInput = text.inputEl;
                text.setValue(this.model?.modelId || '');
            });

        // Base URL
        this.baseUrlSetting = new Setting(contentEl)
            .setName('Base URL')
            .setDesc('Required endpoint URL for this model')
            .addText((text) => {
                this.baseUrlInput = text.inputEl;
                text.setValue(this.model?.baseUrl || '');
            });

        // API Key
        this.apiKeySetting = new Setting(contentEl)
            .setName('API Key')
            .setDesc('Required for providers that need authentication')
            .addText((text) => {
                this.apiKeyInput = text.inputEl;
                text.setValue(this.model?.apiKey || '');
            });

        // Initialize provider-specific field hints
        const initialProvider = this.model?.provider || PROVIDER_CATALOG[0]?.id || 'Ollama';
        this.updateProviderDefaults(initialProvider, !this.model);

        // Context Length (with slider like settings interface)
        this.contextLengthValue = this.model?.contextLength || 4096;
        
        const contextLengthSetting = new Setting(contentEl)
            .setName('Context Length')
            .setDesc('Maximum context token count (4k - 128k)');
        
        // Add a display span for the value in 'k' format
        const valueDisplay = contextLengthSetting.controlEl.createSpan({ cls: 'context-length-display' });
        const updateDisplay = (value: number) => {
            const kValue = Math.round(value / 1024.0);
            valueDisplay.textContent = `${kValue}k`;
        };
        
        contextLengthSetting.addSlider((slider) =>
            slider
                .setLimits(4096, 131072, 1024)
                .setValue(this.contextLengthValue)
                .setDynamicTooltip()
                .onChange((value) => {
                    this.contextLengthValue = value;
                    updateDisplay(value);
                })
        );
        
        updateDisplay(this.contextLengthValue);

        // Supports Tools
        new Setting(contentEl)
            .setName('Supports Tools')
            .setDesc('Whether this model supports function calling')
            .addToggle((toggle) => {
                toggle.setValue(this.model?.supportsTools ?? true);
                toggle.onChange((value) => {
                    this.supportsTools = value;
                });
            });

        const advancedDetails = contentEl.createEl('details', { cls: 'advanced-model-settings' });
        advancedDetails.createEl('summary', { text: 'Advanced settings' });
        const advancedBody = advancedDetails.createDiv({ cls: 'advanced-model-settings-body' });

        new Setting(advancedBody)
            .setName('Performance Preset')
            .setDesc('Apply recommended defaults for local or cloud models')
            .addDropdown((dropdown) => {
                dropdown.addOption('custom', 'Custom');
                dropdown.addOption('local', 'Local');
                dropdown.addOption('cloud', 'Cloud');
                dropdown.setValue('custom');
                dropdown.onChange((value) => {
                    if (value === 'local' || value === 'cloud') {
                        this.applyPerformancePreset(value);
                    }
                });
            });

        new Setting(advancedBody)
            .setName('Max Tool Iterations')
            .setDesc('Assistant-tool rounds before continuation')
            .addText((text) => {
                this.maxToolIterationsInput = text.inputEl;
                this.maxToolIterationsInput.type = 'number';
                this.maxToolIterationsInput.min = '1';
                this.applyNumericInputStyle(this.maxToolIterationsInput);
                text.setPlaceholder('8').setValue(String(this.model?.maxToolIterations ?? ''));
            });

        new Setting(advancedBody)
            .setName('Max Tool Calls Per Turn')
            .setDesc('Total tool calls budget before continuation')
            .addText((text) => {
                this.maxToolCallsPerTurnInput = text.inputEl;
                this.maxToolCallsPerTurnInput.type = 'number';
                this.maxToolCallsPerTurnInput.min = '1';
                this.applyNumericInputStyle(this.maxToolCallsPerTurnInput);
                text.setPlaceholder('24').setValue(String(this.model?.maxToolCallsPerTurn ?? ''));
            });

        new Setting(advancedBody)
            .setName('Max Tool Wall Time (ms)')
            .setDesc('Tool loop time budget before continuation')
            .addText((text) => {
                this.maxToolWallTimeMsInput = text.inputEl;
                this.maxToolWallTimeMsInput.type = 'number';
                this.maxToolWallTimeMsInput.min = '1000';
                this.applyNumericInputStyle(this.maxToolWallTimeMsInput);
                text.setPlaceholder('120000').setValue(String(this.model?.maxToolWallTimeMs ?? ''));
            });

        new Setting(advancedBody)
            .setName('Auto Continuation Passes')
            .setDesc('Extra passes when budgets are reached')
            .addText((text) => {
                this.maxContinuationPassesInput = text.inputEl;
                this.maxContinuationPassesInput.type = 'number';
                this.maxContinuationPassesInput.min = '0';
                this.applyNumericInputStyle(this.maxContinuationPassesInput);
                text.setPlaceholder('1').setValue(String(this.model?.maxContinuationPasses ?? ''));
            });

        new Setting(advancedBody)
            .setName('Tool Result Char Ratio')
            .setDesc('Per tool-result max chars ratio of context chars (0.1 - 0.8)')
            .addText((text) => {
                this.maxToolResultCharsRatioInput = text.inputEl;
                this.maxToolResultCharsRatioInput.type = 'number';
                this.maxToolResultCharsRatioInput.min = '0.1';
                this.maxToolResultCharsRatioInput.max = '0.8';
                this.maxToolResultCharsRatioInput.step = '0.05';
                this.applyNumericInputStyle(this.maxToolResultCharsRatioInput);
                text.setPlaceholder('0.25').setValue(String(this.model?.maxToolResultCharsRatio ?? ''));
            });

        new Setting(advancedBody)
            .setName('History Turns')
            .setDesc('Recent turns sent with each request')
            .addText((text) => {
                this.historyTurnsInput = text.inputEl;
                this.historyTurnsInput.type = 'number';
                this.historyTurnsInput.min = '1';
                this.applyNumericInputStyle(this.historyTurnsInput);
                text.setPlaceholder('6').setValue(String(this.model?.historyTurns ?? ''));
            });

        new Setting(advancedBody)
            .setName('Retrieval TopN')
            .setDesc('BM25 candidates before rerank')
            .addText((text) => {
                this.retrievalTopNInput = text.inputEl;
                this.retrievalTopNInput.type = 'number';
                this.retrievalTopNInput.min = '1';
                this.applyNumericInputStyle(this.retrievalTopNInput);
                text.setPlaceholder('20').setValue(String(this.model?.retrievalTopN ?? ''));
            });

        new Setting(advancedBody)
            .setName('Retrieval Rerank TopK')
            .setDesc('Top chunks injected after rerank')
            .addText((text) => {
                this.retrievalRerankTopKInput = text.inputEl;
                this.retrievalRerankTopKInput.type = 'number';
                this.retrievalRerankTopKInput.min = '1';
                this.applyNumericInputStyle(this.retrievalRerankTopKInput);
                text.setPlaceholder('8').setValue(String(this.model?.retrievalRerankTopK ?? ''));
            });

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        
        buttonContainer.createEl('button', { text: 'Cancel', cls: 'modal-cancel-btn' })
            .onClickEvent(() => this.close());

        buttonContainer.createEl('button', { text: 'Test Connection', cls: 'modal-test-btn' })
            .onClickEvent(() => {
                void this.testConnection();
            });
        
        buttonContainer.createEl('button', { text: 'Save', cls: 'modal-save-btn' })
            .onClickEvent(() => this.saveModel());
    }
    
    /**
     * Update placeholder and visibility based on provider
     */
    private updateProviderDefaults(provider: LLMProvider, isNewModel: boolean = false): void {
        const metadata = getProviderMetadata(provider);
        
        // Update base URL placeholder
        this.baseUrlInput.placeholder = metadata.defaultBaseUrl;
        if (isNewModel && !this.baseUrlInput.value) {
            this.baseUrlInput.value = metadata.defaultBaseUrl;
        }
        
        // Update model ID hint
        this.modelIdSetting.setDesc(metadata.modelIdHint);

        this.baseUrlSetting.setName(metadata.baseUrlLabel || 'Base URL');
        this.baseUrlSetting.setDesc(metadata.baseUrlDescription || 'Required endpoint URL for this model');
        this.apiKeySetting.setName(metadata.apiKeyLabel || 'API Key');
        this.apiKeySetting.setDesc(metadata.apiKeyDescription || 'Required for providers that need authentication');
        
        // Show/hide API key field based on provider
        const needsApiKey = metadata.authMode !== 'none';
        this.apiKeySetting.settingEl.style.display = needsApiKey ? 'flex' : 'none';
    }

    private applyPerformancePreset(preset: 'local' | 'cloud'): void {
        if (preset === 'local') {
            this.maxToolIterationsInput.value = '6';
            this.maxToolCallsPerTurnInput.value = '14';
            this.maxToolWallTimeMsInput.value = '9000';
            this.maxContinuationPassesInput.value = '1';
            this.maxToolResultCharsRatioInput.value = '0.2';
            this.historyTurnsInput.value = '4';
            this.retrievalTopNInput.value = '14';
            this.retrievalRerankTopKInput.value = '5';
            return;
        }

        this.maxToolIterationsInput.value = '8';
        this.maxToolCallsPerTurnInput.value = '24';
        this.maxToolWallTimeMsInput.value = '12000';
        this.maxContinuationPassesInput.value = '1';
        this.maxToolResultCharsRatioInput.value = '0.25';
        this.historyTurnsInput.value = '6';
        this.retrievalTopNInput.value = '20';
        this.retrievalRerankTopKInput.value = '8';
    }

    private applyNumericInputStyle(input: HTMLInputElement): void {
        input.style.width = ModelEditModal.INPUT_STYLE.width;
        input.style.boxSizing = ModelEditModal.INPUT_STYLE.boxSizing;
        input.style.border = '1px solid var(--background-modifier-border)';
        input.style.borderRadius = '6px';
        input.style.background = 'var(--background-primary)';
        input.style.color = 'var(--text-normal)';
        input.style.padding = '8px 12px';
        input.style.fontSize = '14px';
        input.style.outline = 'none';

        input.addEventListener('focus', () => {
            input.style.borderColor = 'var(--interactive-accent)';
            input.style.boxShadow = '0 0 0 2px rgba(var(--interactive-accent-rgb), 0.2)';
        });

        input.addEventListener('blur', () => {
            input.style.borderColor = 'var(--background-modifier-border)';
            input.style.boxShadow = 'none';
        });
    }

    private parseOptionalInt(input: HTMLInputElement): number | undefined {
        const raw = input.value.trim();
        if (!raw) {
            return undefined;
        }

        const value = Number(raw);
        if (!Number.isFinite(value)) {
            return undefined;
        }

        return Math.floor(value);
    }

    private parseOptionalFloat(input: HTMLInputElement): number | undefined {
        const raw = input.value.trim();
        if (!raw) {
            return undefined;
        }

        const value = Number(raw);
        if (!Number.isFinite(value)) {
            return undefined;
        }

        return value;
    }

    private parseBoundedOptionalInt(
        input: HTMLInputElement,
        label: string,
        min: number,
        max: number
    ): number | undefined | null {
        const raw = input.value.trim();
        if (!raw) {
            return undefined;
        }

        const value = Number(raw);
        if (!Number.isFinite(value) || !Number.isInteger(value)) {
            new Notice(`${label} must be an integer between ${min} and ${max}`);
            return null;
        }

        if (value < min || value > max) {
            new Notice(`${label} must be between ${min} and ${max}`);
            return null;
        }

        return value;
    }

    private parseBoundedOptionalFloat(
        input: HTMLInputElement,
        label: string,
        min: number,
        max: number
    ): number | undefined | null {
        const raw = input.value.trim();
        if (!raw) {
            return undefined;
        }

        const value = Number(raw);
        if (!Number.isFinite(value)) {
            new Notice(`${label} must be a number between ${min} and ${max}`);
            return null;
        }

        if (value < min || value > max) {
            new Notice(`${label} must be between ${min} and ${max}`);
            return null;
        }

        return value;
    }

    private async saveModel(): Promise<void> {
        const modelConfig = this.buildModelConfig();
        if (!modelConfig) {
            return;
        }

        if (this.model) {
            // Update existing model
            const index = this.plugin.settings.models.findIndex(m => m.id === this.model!.id);
            if (index >= 0) {
                this.plugin.settings.models[index] = modelConfig;
            }
        } else {
            // Add new model
            this.plugin.settings.models.push(modelConfig);
        }

        await this.plugin.saveSettings();
        document.dispatchEvent(new CustomEvent('wikichat:model-updated', {
            detail: {
                currentModelId: this.plugin.settings.currentModelId,
                updatedAt: Date.now(),
            },
        }));
        this.close();
        this.onSave();
    }

    private async testConnection(): Promise<void> {
        const modelConfig = this.buildModelConfig();
        if (!modelConfig) {
            return;
        }

        new Notice('Testing model connection...');
        await this.plugin.checkLLMConnection(modelConfig);
    }

    private buildModelConfig(): ModelConfig | null {
        const name = this.nameInput.value.trim();
        const provider = this.providerSelect.value;
        const modelId = this.modelIdInput.value.trim();
        const baseUrl = this.baseUrlInput.value.trim();
        const apiKey = this.apiKeyInput.value.trim();
        const metadata = getProviderMetadata(provider);
        const requiresApiKey = metadata.authMode === 'required';

        if (!name || !modelId || !baseUrl) {
            new Notice('Name, Model ID, and Base URL are required');
            return null;
        }

        if (requiresApiKey && !apiKey) {
            new Notice('API Key is required for the selected provider');
            return null;
        }

        const maxToolIterations = this.parseBoundedOptionalInt(this.maxToolIterationsInput, 'Max Tool Iterations', 1, 100);
        if (maxToolIterations === null) {
            return null;
        }

        const maxToolCallsPerTurn = this.parseBoundedOptionalInt(this.maxToolCallsPerTurnInput, 'Max Tool Calls Per Turn', 1, 200);
        if (maxToolCallsPerTurn === null) {
            return null;
        }

        const maxToolWallTimeMs = this.parseBoundedOptionalInt(this.maxToolWallTimeMsInput, 'Max Tool Wall Time (ms)', 1000, 120000);
        if (maxToolWallTimeMs === null) {
            return null;
        }

        const maxContinuationPasses = this.parseBoundedOptionalInt(this.maxContinuationPassesInput, 'Auto Continuation Passes', 0, 10);
        if (maxContinuationPasses === null) {
            return null;
        }

        const maxToolResultCharsRatio = this.parseBoundedOptionalFloat(this.maxToolResultCharsRatioInput, 'Tool Result Char Ratio', 0.1, 0.8);
        if (maxToolResultCharsRatio === null) {
            return null;
        }

        const historyTurns = this.parseBoundedOptionalInt(this.historyTurnsInput, 'History Turns', 1, 50);
        if (historyTurns === null) {
            return null;
        }

        const retrievalTopN = this.parseBoundedOptionalInt(this.retrievalTopNInput, 'Retrieval TopN', 1, 200);
        if (retrievalTopN === null) {
            return null;
        }

        const retrievalRerankTopK = this.parseBoundedOptionalInt(this.retrievalRerankTopKInput, 'Retrieval Rerank TopK', 1, 100);
        if (retrievalRerankTopK === null) {
            return null;
        }

        if (
            retrievalTopN !== undefined
            && retrievalRerankTopK !== undefined
            && retrievalRerankTopK > retrievalTopN
        ) {
            new Notice('Retrieval Rerank TopK cannot be greater than Retrieval TopN');
            return null;
        }

        return {
            id: this.model?.id || `${provider}-${modelId}-${Date.now()}`,
            name,
            provider,
            modelId,
            baseUrl,
            apiKey: apiKey || undefined,
            contextLength: this.contextLengthValue,
            description: this.model?.description,
            supportsTools: this.supportsTools,
            maxToolIterations,
            maxToolCallsPerTurn,
            maxToolWallTimeMs,
            maxContinuationPasses,
            maxToolResultCharsRatio,
            historyTurns,
            retrievalTopN,
            retrievalRerankTopK,
            isDefault: this.model?.isDefault || false,
        };
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}

/**
 * Embedding Model Edit Modal �?mirrors ModelEditModal for EmbeddingModelConfig
 */
class EmbeddingModelEditModal extends Modal {
    private plugin: LLMWikiPlugin;
    private model: EmbeddingModelConfig | null;
    private onSave: () => void;

    private nameInput!: HTMLInputElement;
    private providerSelect!: HTMLSelectElement;
    private modelIdInput!: HTMLInputElement;
    private baseUrlInput!: HTMLInputElement;
    private apiKeyInput!: HTMLInputElement;

    private baseUrlSetting!: Setting;
    private modelIdSetting!: Setting;
    private apiKeySetting!: Setting;

    constructor(app: App, plugin: LLMWikiPlugin, model: EmbeddingModelConfig | null, onSave: () => void) {
        super(app);
        this.plugin = plugin;
        this.model  = model;
        this.onSave = onSave;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('model-edit-modal');
        contentEl.createEl('h2', { text: this.model ? 'Edit Embedding Model' : 'Add Embedding Model' });

        new Setting(contentEl)
            .setName('Display Name')
            .setDesc('Name shown in the embedding model selector')
            .addText((text) => {
                this.nameInput = text.inputEl;
                text.setValue(this.model?.name || '');
            });

        new Setting(contentEl)
            .setName('Provider')
            .setDesc('API provider for this embedding model')
            .addDropdown((dropdown) => {
                for (const provider of PROVIDER_CATALOG) {
                    dropdown.addOption(provider.id, provider.displayName);
                }
                const defaultProvider = this.model?.provider || PROVIDER_CATALOG[0]?.id || 'Ollama';
                dropdown.setValue(defaultProvider);
                dropdown.onChange((value) => this.updateProviderDefaults(value));
                this.providerSelect = dropdown.selectEl;
                this.providerSelect.addClass('provider-select-input');
            });

        this.modelIdSetting = new Setting(contentEl)
            .setName('Embedding Model ID')
            .setDesc('e.g. nomic-embed-text, text-embedding-3-small')
            .addText((text) => {
                this.modelIdInput = text.inputEl;
                text.setValue(this.model?.modelId || '');
            });

        this.baseUrlSetting = new Setting(contentEl)
            .setName('Base URL')
            .setDesc('Endpoint URL for embedding API')
            .addText((text) => {
                this.baseUrlInput = text.inputEl;
                text.setValue(this.model?.baseUrl || '');
            });

        this.apiKeySetting = new Setting(contentEl)
            .setName('API Key')
            .setDesc('Required for cloud providers')
            .addText((text) => {
                this.apiKeyInput = text.inputEl;
                text.setValue(this.model?.apiKey || '');
            });

        const initialProvider = this.model?.provider || PROVIDER_CATALOG[0]?.id || 'Ollama';
        this.updateProviderDefaults(initialProvider, !this.model);

        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        buttonContainer.createEl('button', { text: 'Cancel', cls: 'modal-cancel-btn' })
            .onClickEvent(() => this.close());
        buttonContainer.createEl('button', { text: 'Save', cls: 'modal-save-btn' })
            .onClickEvent(() => void this.saveModel());
    }

    private updateProviderDefaults(provider: LLMProvider, isNewModel = false): void {
        const metadata = getProviderMetadata(provider);
        this.baseUrlInput.placeholder = metadata.defaultBaseUrl;
        if (isNewModel && !this.baseUrlInput.value) {
            this.baseUrlInput.value = metadata.defaultBaseUrl;
        }
        this.modelIdSetting.setDesc(metadata.modelIdHint);
        this.baseUrlSetting.setName(metadata.baseUrlLabel || 'Base URL');
        this.baseUrlSetting.setDesc(metadata.baseUrlDescription || 'Endpoint URL for embedding API');
        this.apiKeySetting.setName(metadata.apiKeyLabel || 'API Key');
        this.apiKeySetting.setDesc(metadata.apiKeyDescription || 'Required for cloud providers');
        const needsApiKey = metadata.authMode !== 'none';
        this.apiKeySetting.settingEl.style.display = needsApiKey ? 'flex' : 'none';
    }

    private async saveModel(): Promise<void> {
        const name    = this.nameInput.value.trim();
        const provider = this.providerSelect.value;
        const modelId  = this.modelIdInput.value.trim();
        const baseUrl  = this.baseUrlInput.value.trim();
        const apiKey   = this.apiKeyInput.value.trim();
        const metadata = getProviderMetadata(provider);

        if (!name || !modelId || !baseUrl) {
            new Notice('Name, Model ID, and Base URL are required');
            return;
        }
        if (metadata.authMode === 'required' && !apiKey) {
            new Notice('API Key is required for the selected provider');
            return;
        }

        const cfg: EmbeddingModelConfig = {
            id:       this.model?.id || `embed-${provider}-${modelId}-${Date.now()}`,
            name,
            provider,
            modelId,
            baseUrl,
            apiKey:   apiKey || undefined,
        };

        if (!this.plugin.settings.embeddingModels) {
            this.plugin.settings.embeddingModels = [];
        }

        if (this.model) {
            const idx = this.plugin.settings.embeddingModels.findIndex(m => m.id === this.model!.id);
            if (idx >= 0) this.plugin.settings.embeddingModels[idx] = cfg;
        } else {
            this.plugin.settings.embeddingModels.push(cfg);
        }

        await this.plugin.saveSettings();
        this.close();
        this.onSave();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

