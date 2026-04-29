/**
 * WikiSearchEngine — in-memory BM25 index + optional embedding rerank
 *
 * Pipeline:
 *   1. build()  — scan metadataCache for all wiki md files (zero I/O)
 *   2. search() — BM25 + recency boost → top-N SearchResult
 *   3. rerank() — optional embedding cosine rerank → top-K ChunkResult
 *                 falls back to BM25-only when embedFn is null
 */

import type { App, TFile } from 'obsidian';
import type { LLMWikiSettings } from '../types';

// ─── BM25 constants ──────────────────────────────────────────────────────────
const BM25_K1 = 1.5;
const BM25_B  = 0.75;

/** Field weights applied when computing weighted term frequency */
const W: Record<FieldName, number> = {
    title:    3.0,
    tags:     2.5,
    summary:  2.0,
    headings: 1.5,
};

type FieldName = 'title' | 'tags' | 'summary' | 'headings';

// ─── Internal data structures ─────────────────────────────────────────────────
interface DocRecord {
    path:    string;
    title:   string;
    tags:    string[];
    summary: string;
    headings: string[];
    ctime:   number;          // vault creation timestamp (ms), used for recency

    tfTitle:    Map<string, number>;
    tfTags:     Map<string, number>;
    tfSummary:  Map<string, number>;
    tfHeadings: Map<string, number>;

    lenTitle:    number;
    lenTags:     number;
    lenSummary:  number;
    lenHeadings: number;
}

/** Inverted index entry: df = document frequency, docs maps path → weighted tf */
interface InvertedEntry {
    df: number;
    docs: Map<string, number>; // path → sum of weighted tf across fields
}

// ─── Public interfaces ────────────────────────────────────────────────────────
export interface SearchResult {
    path:    string;
    title:   string;
    summary: string;
    bm25:    number;
    ctime:   number;
}

export interface ChunkResult {
    path:  string;
    title: string;
    chunk: string;
    score: number;
}

// ─── Main engine ──────────────────────────────────────────────────────────────
export class WikiSearchEngine {
    private app: App;
    private settings: LLMWikiSettings;
    private docs    = new Map<string, DocRecord>();       // path → DocRecord
    private index   = new Map<string, InvertedEntry>();  // term → InvertedEntry
    private ready   = false;

    // Cached averages per field (updated after build)
    private avgLen: Record<FieldName, number> = { title: 0, tags: 0, summary: 0, headings: 0 };

    constructor(app: App, settings: LLMWikiSettings) {
        this.app      = app;
        this.settings = settings;
    }

    /** Build the in-memory index from metadataCache. Fire-and-forget safe. */
    build(): void {
        try {
            this.docs.clear();
            this.index.clear();
            this.ready = false;

            const wikiPath  = this.settings.wikiPath || 'Wiki';
            const allFiles  = this.app.vault.getMarkdownFiles();
            const wikiFiles = allFiles.filter(f => f.path.startsWith(wikiPath + '/'));

            for (const file of wikiFiles) {
                this.indexFile(file);
            }

            this.computeAverages();
            this.ready = true;
        } catch (e) {
            console.warn('[WikiSearchEngine] build() failed:', e);
        }
    }

    isReady(): boolean { return this.ready; }

    /** Incremental update on file creation */
    onFileCreated(file: TFile): void {
        if (!file.path.startsWith((this.settings.wikiPath || 'Wiki') + '/')) return;
        this.indexFile(file);
        this.computeAverages();
    }

    /** Incremental update on file deletion */
    onFileDeleted(path: string): void {
        if (!this.docs.has(path)) return;
        this.removeFromIndex(path);
        this.docs.delete(path);
        this.computeAverages();
    }

    /** Incremental update on file modification */
    onFileChanged(file: TFile): void {
        if (!file.path.startsWith((this.settings.wikiPath || 'Wiki') + '/')) return;
        this.removeFromIndex(file.path);
        this.indexFile(file);
        this.computeAverages();
    }

    /**
     * BM25 search with recency boost.
     * Returns top-N results sorted by score descending.
     */
    search(query: string, topN = 30): SearchResult[] {
        if (!this.ready || this.docs.size === 0) return [];

        const queryTerms = tokenize(query);
        if (queryTerms.length === 0) return [];

        const N = this.docs.size;
        const scores = new Map<string, number>();

        for (const term of queryTerms) {
            const entry = this.index.get(term);
            if (!entry || entry.df === 0) continue;

            const idf = Math.log((N - entry.df + 0.5) / (entry.df + 0.5) + 1);

            for (const [path, weightedTf] of entry.docs) {
                const doc = this.docs.get(path)!;
                // Average document "length" weighted by field weights
                const docLen = (
                    doc.lenTitle    * W.title +
                    doc.lenTags     * W.tags  +
                    doc.lenSummary  * W.summary +
                    doc.lenHeadings * W.headings
                );
                const avgDocLen = (
                    this.avgLen.title    * W.title +
                    this.avgLen.tags     * W.tags  +
                    this.avgLen.summary  * W.summary +
                    this.avgLen.headings * W.headings
                );
                const normalizedLen = avgDocLen > 0 ? docLen / avgDocLen : 1;
                const tf = weightedTf / (weightedTf + BM25_K1 * (1 - BM25_B + BM25_B * normalizedLen));
                const score = idf * tf;

                scores.set(path, (scores.get(path) ?? 0) + score);
            }
        }

        if (scores.size === 0) return [];

        // Recency boost: +1%/month up to +12%, -1%/month down to -12%
        const nowMs = Date.now();
        const results: SearchResult[] = [];
        for (const [path, bm25] of scores) {
            const doc  = this.docs.get(path)!;
            const ageMonths = (nowMs - doc.ctime) / (1000 * 60 * 60 * 24 * 30);
            const recency   = 1 + clamp(12 - ageMonths, -12, 12) * 0.01;
            results.push({
                path,
                title:   doc.title,
                summary: doc.summary,
                bm25:    bm25 * recency,
                ctime:   doc.ctime,
            });
        }

        results.sort((a, b) => b.bm25 - a.bm25);
        return results.slice(0, topN);
    }

    /**
     * Rerank top-N BM25 results with optional embedding cosine similarity.
     * If embedFn is null, returns top-K by BM25 using summary as chunk.
     * If embedFn is provided, reads file content and extracts best chunk per page.
     */
    async rerank(
        query: string,
        candidates: SearchResult[],
        embedFn: ((text: string) => Promise<number[]>) | null,
        topK = 10
    ): Promise<ChunkResult[]> {
        if (candidates.length === 0) return [];

        if (!embedFn) {
            // BM25-only fallback: return top-K using summary as the chunk
            return candidates.slice(0, topK).map(c => ({
                path:  c.path,
                title: c.title,
                chunk: c.summary || '',
                score: c.bm25,
            }));
        }

        // Normalise BM25 scores to [0,1]
        const maxBm25 = candidates[0].bm25 || 1;
        const bm25Norm = candidates.map(c => c.bm25 / maxBm25);

        // Embed query
        const queryVec = await embedFn(query);
        if (!queryVec || queryVec.length === 0) {
            // Embedding failed — fall back to BM25
            return candidates.slice(0, topK).map(c => ({
                path:  c.path,
                title: c.title,
                chunk: c.summary || '',
                score: c.bm25,
            }));
        }

        // Embed summaries in batches of 5
        const BATCH = 5;
        const embeddings: number[][] = new Array(candidates.length).fill([]);
        for (let i = 0; i < candidates.length; i += BATCH) {
            const batch = candidates.slice(i, i + BATCH);
            const vecs = await Promise.all(batch.map(c => embedFn(c.summary || c.title).catch(() => [])));
            for (let j = 0; j < vecs.length; j++) {
                embeddings[i + j] = vecs[j];
            }
        }

        // Score: 0.4 × bm25Norm + 0.6 × cosine
        const queryTerms = tokenize(query);
        const scored: Array<{ idx: number; score: number }> = candidates.map((_, i) => {
            const cosine = embeddings[i].length > 0 ? cosineSim(queryVec, embeddings[i]) : 0;
            return { idx: i, score: 0.4 * bm25Norm[i] + 0.6 * cosine };
        });

        scored.sort((a, b) => b.score - a.score);
        const topCandidates = scored.slice(0, topK);

        // Read files and extract best chunk for the top-K
        const results: ChunkResult[] = await Promise.all(
            topCandidates.map(async ({ idx, score }) => {
                const c = candidates[idx];
                let chunk = c.summary || '';
                try {
                    const file = this.app.vault.getAbstractFileByPath(c.path) as TFile | null;
                    if (file) {
                        const content = await this.app.vault.read(file);
                        chunk = extractBestChunk(content, queryTerms);
                    }
                } catch (_) { /* keep summary as fallback */ }
                return { path: c.path, title: c.title, chunk, score };
            })
        );

        results.sort((a, b) => b.score - a.score);
        return results;
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private indexFile(file: TFile): void {
        try {
            const cache = this.app.metadataCache.getFileCache(file);
            const fm    = cache?.frontmatter;

            const title    = (fm?.['title'] as string | undefined)   || file.basename;
            const rawTags  = fm?.['tags'];
            const tags: string[] = Array.isArray(rawTags)
                ? rawTags.map(String)
                : (typeof rawTags === 'string' ? [rawTags] : []);
            const summary  = (fm?.['summary'] as string | undefined)  || '';
            const headings = (cache?.headings ?? []).map(h => h.heading);
            const ctime    = file.stat.ctime;

            const tfTitle    = tfMap(tokenize(title));
            const tfTags     = tfMap(tokenize(tags.join(' ')));
            const tfSummary  = tfMap(tokenize(summary));
            const tfHeadings = tfMap(tokenize(headings.join(' ')));

            const rec: DocRecord = {
                path: file.path, title, tags, summary, headings, ctime,
                tfTitle, tfTags, tfSummary, tfHeadings,
                lenTitle:    tokens(tfTitle),
                lenTags:     tokens(tfTags),
                lenSummary:  tokens(tfSummary),
                lenHeadings: tokens(tfHeadings),
            };

            this.docs.set(file.path, rec);

            // Accumulate weighted tf into inverted index
            this.addFieldToIndex(file.path, tfTitle,    W.title);
            this.addFieldToIndex(file.path, tfTags,     W.tags);
            this.addFieldToIndex(file.path, tfSummary,  W.summary);
            this.addFieldToIndex(file.path, tfHeadings, W.headings);
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
            if (prev === 0) entry.df++;
            entry.docs.set(path, prev + freq * weight);
        }
    }

    private removeFromIndex(path: string): void {
        const rec = this.docs.get(path);
        if (!rec) return;

        const allTerms = new Set([
            ...rec.tfTitle.keys(),
            ...rec.tfTags.keys(),
            ...rec.tfSummary.keys(),
            ...rec.tfHeadings.keys(),
        ]);
        for (const term of allTerms) {
            const entry = this.index.get(term);
            if (!entry) continue;
            if (entry.docs.delete(path)) {
                entry.df--;
                if (entry.df <= 0) this.index.delete(term);
            }
        }
    }

    private computeAverages(): void {
        if (this.docs.size === 0) {
            this.avgLen = { title: 0, tags: 0, summary: 0, headings: 0 };
            return;
        }
        let sumTitle = 0, sumTags = 0, sumSummary = 0, sumHeadings = 0;
        for (const d of this.docs.values()) {
            sumTitle    += d.lenTitle;
            sumTags     += d.lenTags;
            sumSummary  += d.lenSummary;
            sumHeadings += d.lenHeadings;
        }
        const n = this.docs.size;
        this.avgLen = {
            title:    sumTitle    / n,
            tags:     sumTags     / n,
            summary:  sumSummary  / n,
            headings: sumHeadings / n,
        };
    }
}

// ─── Utility functions ────────────────────────────────────────────────────────

/** Tokenise text: alphanumeric + CJK, lowercase, min length 2 */
function tokenize(text: string): string[] {
    const matches = text.match(/[A-Za-z0-9\u4e00-\u9fa5]+/g);
    if (!matches) return [];
    return matches.map(t => t.toLowerCase()).filter(t => t.length >= 2);
}

/** Build term-frequency map */
function tfMap(tokens: string[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
}

/** Total token count from a tf map */
function tokens(tf: Map<string, number>): number {
    let n = 0;
    for (const v of tf.values()) n += v;
    return n;
}

function clamp(val: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, val));
}

/** Cosine similarity between two vectors */
function cosineSim(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot   += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
}

/**
 * Extract the best H2 section from file content based on query term overlap.
 * Returns at most 600 words of text.
 */
function extractBestChunk(content: string, queryTerms: string[]): string {
    // Strip frontmatter
    const body = content.replace(/^---[\s\S]*?---\n/, '');

    // Split on H2 headings
    const sections = body.split(/(?=^## .+)/m);
    if (sections.length === 0) return truncateWords(body, 600);

    const termSet = new Set(queryTerms);
    let bestSection = sections[0];
    let bestOverlap = -1;

    for (const section of sections) {
        const sectionTerms = tokenize(section);
        let overlap = 0;
        for (const t of sectionTerms) {
            if (termSet.has(t)) overlap++;
        }
        if (overlap > bestOverlap) {
            bestOverlap  = overlap;
            bestSection = section;
        }
    }

    return truncateWords(bestSection.trim(), 600);
}

function truncateWords(text: string, maxWords: number): string {
    const words = text.split(/\s+/);
    if (words.length <= maxWords) return text;
    return words.slice(0, maxWords).join(' ') + ' …';
}
