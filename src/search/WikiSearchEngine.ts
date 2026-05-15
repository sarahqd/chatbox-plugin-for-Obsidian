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
            await yieldToUI();
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

    /**
     * Find similar terms in the index using edit distance.
     * Used for fuzzy matching when exact BM25 returns no results.
     */
    private findSimilarTerms(queryTerms: string[], maxDistance: number): Map<string, string[]> {
        const similarMap = new Map<string, string[]>();
        
        for (const queryTerm of queryTerms) {
            const similar: string[] = [];
            const queryLen = queryTerm.length;
            
            for (const [indexTerm] of this.index) {
                // Optimization: skip if length difference is too large
                if (Math.abs(indexTerm.length - queryLen) > maxDistance) {
                    continue;
                }
                
                const dist = editDistance(queryTerm, indexTerm);
                if (dist <= maxDistance && dist > 0) {
                    similar.push(indexTerm);
                }
            }
            
            if (similar.length > 0) {
                similarMap.set(queryTerm, similar);
            }
        }
        
        return similarMap;
    }

    /**
     * Fuzzy search using edit distance when exact BM25 returns no results.
     * Finds similar terms in the index and searches with those.
     */
    searchFuzzy(query: string, topN = 30, maxDistance = 2): SearchResult[] {
        if (!this.ready || this.docs.size === 0) {
            return [];
        }

        const queryTerms = tokenize(query);
        if (queryTerms.length === 0) {
            return [];
        }

        // Find similar terms for each query term
        const similarTermsMap = this.findSimilarTerms(queryTerms, maxDistance);
        if (similarTermsMap.size === 0) {
            return [];
        }

        // Build expanded query terms (original + similar)
        const expandedTerms: string[] = [];
        for (const [original, similar] of similarTermsMap) {
            expandedTerms.push(original, ...similar);
        }

        // Perform BM25 search with expanded terms
        const docCount = this.docs.size;
        const scores = new Map<string, number>();

        for (const term of expandedTerms) {
            const entry = this.index.get(term);
            if (!entry || entry.df === 0) {
                continue;
            }

            // Penalize fuzzy matches with lower IDF
            const isFuzzyMatch = !queryTerms.includes(term);
            const idf = Math.log((docCount - entry.df + 0.5) / (entry.df + 0.5) + 1);
            const fuzzyPenalty = isFuzzyMatch ? 0.7 : 1.0;

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
                const score = idf * tf * fuzzyPenalty;

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

    /**
     * Unified search entry with fallback chain.
     * 1. Try exact BM25 search
     * 2. If no results, try fuzzy matching
     */
    searchWithFallback(query: string, topN = 30): SearchResult[] {
        // Stage 1: Exact BM25
        const exactResults = this.search(query, topN);
        if (exactResults.length > 0) {
            return exactResults;
        }

        // Stage 2: Fuzzy matching
        const fuzzyResults = this.searchFuzzy(query, topN);
        if (fuzzyResults.length > 0) {
            return fuzzyResults;
        }

        // Stage 3: Cached metadata substring/overlap scan.
        // This is still zero-I/O and catches path/title/tag fragments BM25 did not tokenize.
        return this.searchMetadataFallback(query, topN);
    }

    private searchMetadataFallback(query: string, topN = 30): SearchResult[] {
        if (!this.ready || this.docs.size === 0) {
            return [];
        }

        const normalizedQuery = query.trim().toLowerCase();
        const queryTerms = tokenize(query);
        if (!normalizedQuery && queryTerms.length === 0) {
            return [];
        }

        const scored: SearchResult[] = [];
        for (const doc of this.docs.values()) {
            const haystack = [
                doc.path,
                doc.title,
                doc.tags.join(' '),
                doc.summary,
                doc.headings.join(' '),
            ].join(' ').toLowerCase();

            let score = 0;
            if (normalizedQuery && haystack.includes(normalizedQuery)) {
                score += 3;
            }

            for (const term of queryTerms) {
                if (haystack.includes(term)) {
                    score += 1;
                }
            }

            if (score > 0) {
                scored.push({
                    path: doc.path,
                    title: doc.title,
                    summary: doc.summary,
                    bm25: score,
                    ctime: doc.ctime,
                });
            }
        }

        scored.sort((left, right) => {
            if (right.bm25 !== left.bm25) {
                return right.bm25 - left.bm25;
            }

            return right.ctime - left.ctime;
        });

        return scored.slice(0, topN);
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

/**
 * Tokenize text for BM25 indexing/searching.
 * 
 * For Chinese text, we use a hybrid approach:
 * 1. Whole words (continuous Chinese characters) as tokens
 * 2. Bigrams (2-character sliding window) for partial matching
 */
function tokenize(text: string): string[] {
    const tokens: string[] = [];
    const seen = new Set<string>();
    
    // Match continuous sequences of same character type
    const matches = text.match(/[A-Za-z0-9]+|[\u4e00-\u9fa5]+/g);
    if (!matches) {
        return [];
    }

    for (const match of matches) {
        const lower = match.toLowerCase();
        
        // Check if this is a Chinese sequence
        const isChinese = /^[\u4e00-\u9fa5]+$/.test(match);
        
        if (isChinese) {
            // For Chinese: add whole word + bigrams
            if (lower.length >= 2) {
                // Add whole word as token (for exact match)
                if (!seen.has(lower)) {
                    tokens.push(lower);
                    seen.add(lower);
                }
                
                // Add bigrams (2-char sliding window) for partial matching
                for (let i = 0; i < lower.length - 1; i++) {
                    const bigram = lower.slice(i, i + 2);
                    if (!seen.has(bigram)) {
                        tokens.push(bigram);
                        seen.add(bigram);
                    }
                }
                
                // Add trigrams for better phrase matching
                for (let i = 0; i < lower.length - 2; i++) {
                    const trigram = lower.slice(i, i + 3);
                    if (!seen.has(trigram)) {
                        tokens.push(trigram);
                        seen.add(trigram);
                    }
                }
            }
        } else {
            // For non-Chinese (English, numbers): add as single token
            if (lower.length >= 2 && !seen.has(lower)) {
                tokens.push(lower);
                seen.add(lower);
            }
        }
    }

    return tokens;
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

async function yieldToUI(): Promise<void> {
    await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 0);
    });
}

/**
 * Calculate Levenshtein edit distance between two strings.
 * Used for fuzzy term matching.
 */
function editDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    
    // Quick optimization: if length difference exceeds threshold, skip
    if (Math.abs(m - n) > 2) {
        return Math.max(m, n);
    }
    
    // DP table: dp[i][j] = edit distance between a[0..i-1] and b[0..j-1]
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    
    // Base cases
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    
    // Fill DP table
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(
                    dp[i - 1][j],     // deletion
                    dp[i][j - 1],     // insertion
                    dp[i - 1][j - 1]  // substitution
                );
            }
        }
    }
    
    return dp[m][n];
}
