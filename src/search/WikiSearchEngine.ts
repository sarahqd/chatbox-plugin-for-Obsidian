/**
 * WikiSearchEngine: in-memory BM25 index + optional embedding rerank.
 *
 * Pipeline:
 *   1. build()/rebuildInBatches() scans metadataCache for wiki markdown files
 *   2. search() performs BM25 + recency boost
 *   3. rerank() optionally applies embedding similarity to top BM25 candidates
 */

import type { App, TFile } from 'obsidian';
import type { LLMWikiSettings } from '../types';

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const DEFAULT_REBUILD_BATCH_SIZE = 250;

const W: Record<FieldName, number> = {
    title: 3.0,
    tags: 2.5,
    summary: 2.0,
    headings: 1.5,
};

type FieldName = 'title' | 'tags' | 'summary' | 'headings';

interface DocRecord {
    path: string;
    title: string;
    tags: string[];
    summary: string;
    headings: string[];
    ctime: number;
    tfTitle: Map<string, number>;
    tfTags: Map<string, number>;
    tfSummary: Map<string, number>;
    tfHeadings: Map<string, number>;
    lenTitle: number;
    lenTags: number;
    lenSummary: number;
    lenHeadings: number;
}

interface InvertedEntry {
    df: number;
    docs: Map<string, number>;
}

export interface SearchResult {
    path: string;
    title: string;
    summary: string;
    bm25: number;
    ctime: number;
}

export interface ChunkResult {
    path: string;
    title: string;
    chunk: string;
    score: number;
}

export class WikiSearchEngine {
    private app: App;
    private settings: LLMWikiSettings;
    private docs = new Map<string, DocRecord>();
    private index = new Map<string, InvertedEntry>();
    private ready = false;
    private totalLen: Record<FieldName, number> = { title: 0, tags: 0, summary: 0, headings: 0 };
    private avgLen: Record<FieldName, number> = { title: 0, tags: 0, summary: 0, headings: 0 };

    constructor(app: App, settings: LLMWikiSettings) {
        this.app = app;
        this.settings = settings;
    }

    build(): void {
        try {
            this.reset();
            const wikiFiles = this.getWikiFiles();
            for (const file of wikiFiles) {
                this.indexFile(file);
            }
            this.ready = true;
        } catch (e) {
            console.warn('[WikiSearchEngine] build() failed:', e);
            this.ready = false;
        }
    }

    async rebuildInBatches(
        batchSize: number = DEFAULT_REBUILD_BATCH_SIZE,
        onProgress?: (indexed: number, total: number) => void
    ): Promise<number> {
        const wikiFiles = this.getWikiFiles();
        this.reset();

        for (let start = 0; start < wikiFiles.length; start += batchSize) {
            const batch = wikiFiles.slice(start, start + batchSize);
            for (const file of batch) {
                this.indexFile(file);
            }

            onProgress?.(Math.min(start + batch.length, wikiFiles.length), wikiFiles.length);
            await yieldToUi();
        }

        this.ready = true;
        return wikiFiles.length;
    }

    isReady(): boolean {
        return this.ready;
    }

    onFileCreated(file: TFile): void {
        if (!this.isWikiFile(file.path)) {
            return;
        }

        this.indexFile(file);
    }

    onFileDeleted(path: string): void {
        if (!this.docs.has(path)) {
            return;
        }

        this.removeDoc(path);
    }

    onFileChanged(file: TFile): void {
        if (!this.isWikiFile(file.path)) {
            return;
        }

        this.removeDoc(file.path);
        this.indexFile(file);
    }

    search(query: string, topN = 30): SearchResult[] {
        if (!this.ready || this.docs.size === 0) {
            return [];
        }

        const queryTerms = tokenize(query);
        if (queryTerms.length === 0) {
            return [];
        }

        const docCount = this.docs.size;
        const scores = new Map<string, number>();

        for (const term of queryTerms) {
            const entry = this.index.get(term);
            if (!entry || entry.df === 0) {
                continue;
            }

            const idf = Math.log((docCount - entry.df + 0.5) / (entry.df + 0.5) + 1);

            for (const [path, weightedTf] of entry.docs) {
                const doc = this.docs.get(path);
                if (!doc) {
                    continue;
                }

                const docLen = (
                    doc.lenTitle * W.title +
                    doc.lenTags * W.tags +
                    doc.lenSummary * W.summary +
                    doc.lenHeadings * W.headings
                );
                const avgDocLen = (
                    this.avgLen.title * W.title +
                    this.avgLen.tags * W.tags +
                    this.avgLen.summary * W.summary +
                    this.avgLen.headings * W.headings
                );
                const normalizedLen = avgDocLen > 0 ? docLen / avgDocLen : 1;
                const tf = weightedTf / (weightedTf + BM25_K1 * (1 - BM25_B + BM25_B * normalizedLen));
                const score = idf * tf;

                scores.set(path, (scores.get(path) ?? 0) + score);
            }
        }

        if (scores.size === 0) {
            return [];
        }

        const nowMs = Date.now();
        const results: SearchResult[] = [];
        for (const [path, bm25] of scores) {
            const doc = this.docs.get(path);
            if (!doc) {
                continue;
            }

            const ageMonths = (nowMs - doc.ctime) / (1000 * 60 * 60 * 24 * 30);
            const recency = 1 + clamp(12 - ageMonths, -12, 12) * 0.01;
            results.push({
                path,
                title: doc.title,
                summary: doc.summary,
                bm25: bm25 * recency,
                ctime: doc.ctime,
            });
        }

        results.sort((a, b) => b.bm25 - a.bm25);
        return results.slice(0, topN);
    }

    async rerank(
        query: string,
        candidates: SearchResult[],
        embedFn: ((text: string) => Promise<number[]>) | null,
        topK = 10
    ): Promise<ChunkResult[]> {
        if (candidates.length === 0) {
            return [];
        }

        if (!embedFn) {
            return candidates.slice(0, topK).map((candidate) => ({
                path: candidate.path,
                title: candidate.title,
                chunk: candidate.summary || '',
                score: candidate.bm25,
            }));
        }

        const maxBm25 = candidates[0].bm25 || 1;
        const bm25Norm = candidates.map((candidate) => candidate.bm25 / maxBm25);

        const queryVec = await embedFn(query);
        if (!queryVec || queryVec.length === 0) {
            return candidates.slice(0, topK).map((candidate) => ({
                path: candidate.path,
                title: candidate.title,
                chunk: candidate.summary || '',
                score: candidate.bm25,
            }));
        }

        const embeddings: number[][] = new Array(candidates.length).fill([]);
        for (let start = 0; start < candidates.length; start += 5) {
            const batch = candidates.slice(start, start + 5);
            const vectors = await Promise.all(batch.map((candidate) => embedFn(candidate.summary || candidate.title).catch(() => [])));
            for (let offset = 0; offset < vectors.length; offset++) {
                embeddings[start + offset] = vectors[offset];
            }
        }

        const queryTerms = tokenize(query);
        const scored = candidates.map((_, index) => {
            const cosine = embeddings[index].length > 0 ? cosineSim(queryVec, embeddings[index]) : 0;
            return { idx: index, score: 0.4 * bm25Norm[index] + 0.6 * cosine };
        });

        scored.sort((left, right) => right.score - left.score);
        const topCandidates = scored.slice(0, topK);

        const results = await Promise.all(
            topCandidates.map(async ({ idx, score }) => {
                const candidate = candidates[idx];
                let chunk = candidate.summary || '';
                try {
                    const file = this.app.vault.getAbstractFileByPath(candidate.path) as TFile | null;
                    if (file) {
                        const content = await this.app.vault.read(file);
                        chunk = extractBestChunk(content, queryTerms);
                    }
                } catch (_) {
                    // Keep the summary fallback.
                }

                return { path: candidate.path, title: candidate.title, chunk, score };
            })
        );

        results.sort((left, right) => right.score - left.score);
        return results;
    }

    private getWikiFiles(): TFile[] {
        return this.app.vault.getMarkdownFiles().filter((file) => this.isWikiFile(file.path));
    }

    private isWikiFile(path: string): boolean {
        return path.startsWith((this.settings.wikiPath || 'Wiki') + '/');
    }

    private reset(): void {
        this.docs.clear();
        this.index.clear();
        this.ready = false;
        this.totalLen = { title: 0, tags: 0, summary: 0, headings: 0 };
        this.avgLen = { title: 0, tags: 0, summary: 0, headings: 0 };
    }

    private indexFile(file: TFile): void {
        try {
            const existing = this.docs.get(file.path);
            if (existing) {
                this.removeDoc(file.path);
            }

            const cache = this.app.metadataCache.getFileCache(file);
            const frontmatter = cache?.frontmatter;

            const title = (frontmatter?.title as string | undefined) || file.basename;
            const rawTags = frontmatter?.tags;
            const tags = Array.isArray(rawTags)
                ? rawTags.map(String)
                : typeof rawTags === 'string'
                    ? [rawTags]
                    : [];
            const summary = (frontmatter?.summary as string | undefined) || '';
            const headings = (cache?.headings ?? []).map((heading) => heading.heading);
            const ctime = file.stat.ctime;

            const tfTitle = tfMap(tokenize(title));
            const tfTags = tfMap(tokenize(tags.join(' ')));
            const tfSummary = tfMap(tokenize(summary));
            const tfHeadings = tfMap(tokenize(headings.join(' ')));

            const record: DocRecord = {
                path: file.path,
                title,
                tags,
                summary,
                headings,
                ctime,
                tfTitle,
                tfTags,
                tfSummary,
                tfHeadings,
                lenTitle: tokens(tfTitle),
                lenTags: tokens(tfTags),
                lenSummary: tokens(tfSummary),
                lenHeadings: tokens(tfHeadings),
            };

            this.docs.set(file.path, record);
            this.addFieldToIndex(file.path, tfTitle, W.title);
            this.addFieldToIndex(file.path, tfTags, W.tags);
            this.addFieldToIndex(file.path, tfSummary, W.summary);
            this.addFieldToIndex(file.path, tfHeadings, W.headings);
            this.applyRecordLengths(record, 1);
        } catch (e) {
            console.warn('[WikiSearchEngine] indexFile failed for', file.path, e);
        }
    }

    private addFieldToIndex(path: string, tf: Map<string, number>, weight: number): void {
        for (const [term, freq] of tf) {
            let entry = this.index.get(term);
            if (!entry) {
                entry = { df: 0, docs: new Map() };
                this.index.set(term, entry);
            }

            const prev = entry.docs.get(path) ?? 0;
            if (prev === 0) {
                entry.df++;
            }
            entry.docs.set(path, prev + freq * weight);
        }
    }

    private removeDoc(path: string): void {
        const record = this.docs.get(path);
        if (!record) {
            return;
        }

        const allTerms = new Set([
            ...record.tfTitle.keys(),
            ...record.tfTags.keys(),
            ...record.tfSummary.keys(),
            ...record.tfHeadings.keys(),
        ]);

        for (const term of allTerms) {
            const entry = this.index.get(term);
            if (!entry) {
                continue;
            }

            if (entry.docs.delete(path)) {
                entry.df--;
                if (entry.df <= 0) {
                    this.index.delete(term);
                }
            }
        }

        this.docs.delete(path);
        this.applyRecordLengths(record, -1);
    }

    private applyRecordLengths(record: DocRecord, direction: 1 | -1): void {
        this.totalLen.title += record.lenTitle * direction;
        this.totalLen.tags += record.lenTags * direction;
        this.totalLen.summary += record.lenSummary * direction;
        this.totalLen.headings += record.lenHeadings * direction;
        this.refreshAverages();
    }

    private refreshAverages(): void {
        const count = this.docs.size;
        if (count === 0) {
            this.avgLen = { title: 0, tags: 0, summary: 0, headings: 0 };
            return;
        }

        this.avgLen = {
            title: this.totalLen.title / count,
            tags: this.totalLen.tags / count,
            summary: this.totalLen.summary / count,
            headings: this.totalLen.headings / count,
        };
    }
}

function tokenize(text: string): string[] {
    const matches = text.match(/[A-Za-z0-9\u4e00-\u9fa5]+/g);
    if (!matches) {
        return [];
    }

    return matches.map((token) => token.toLowerCase()).filter((token) => token.length >= 2);
}

function tfMap(tokens: string[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const token of tokens) {
        map.set(token, (map.get(token) ?? 0) + 1);
    }
    return map;
}

function tokens(tf: Map<string, number>): number {
    let total = 0;
    for (const value of tf.values()) {
        total += value;
    }
    return total;
}

function clamp(val: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, val));
}

function cosineSim(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) {
        return 0;
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < a.length; index++) {
        dot += a[index] * b[index];
        normA += a[index] * a[index];
        normB += b[index] * b[index];
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
}

function extractBestChunk(content: string, queryTerms: string[]): string {
    const body = content.replace(/^---[\s\S]*?---\n/, '');
    const sections = body.split(/(?=^## .+)/m);
    if (sections.length === 0) {
        return truncateWords(body, 600);
    }

    const termSet = new Set(queryTerms);
    let bestSection = sections[0];
    let bestOverlap = -1;

    for (const section of sections) {
        const sectionTerms = tokenize(section);
        let overlap = 0;
        for (const term of sectionTerms) {
            if (termSet.has(term)) {
                overlap++;
            }
        }

        if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestSection = section;
        }
    }

    return truncateWords(bestSection.trim(), 600);
}

function truncateWords(text: string, maxWords: number): string {
    const words = text.split(/\s+/);
    if (words.length <= maxWords) {
        return text;
    }

    return words.slice(0, maxWords).join(' ') + '...';
}

async function yieldToUi(): Promise<void> {
    await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
    });
}
