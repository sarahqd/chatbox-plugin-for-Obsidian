import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile, TFolder } from 'obsidian';
import { WikiSearchEngine } from '../src/search/WikiSearchEngine';
import { listFilesTool } from '../src/tools/fileTools';
import { updateContentTool, updatePropertyTool, updateSummaryTool, updateWikiPageTool } from '../src/tools/wikiTools';
import { DEFAULT_SETTINGS } from '../src/types';
import { SYSTEM_PROMPT as INGEST_SYSTEM_PROMPT } from '../src/flows/ingest';

type MockFile = TFile & {
    cache?: {
        frontmatter?: Record<string, unknown>;
        headings?: Array<{ heading: string }>;
    };
};

function makeWikiFile(path: string, frontmatter: Record<string, unknown>, headings: string[] = []): MockFile {
    return new TFile(path, {
        stat: { ctime: Date.now(), size: 128 },
        cache: {
            frontmatter,
            headings: headings.map((heading) => ({ heading })),
        },
    }) as MockFile;
}

function makeApp(files: MockFile[], read?: (file: MockFile) => Promise<string>) {
    return {
        vault: {
            getMarkdownFiles: () => files,
            read: read || (async () => ''),
            getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) || null,
        },
        metadataCache: {
            getFileCache: (file: MockFile) => file.cache || null,
        },
    };
}

function makeWritableWikiContext(initialContent: string) {
    const file = new TFile('Wiki/Page.md') as MockFile;
    let content = initialContent;
    const vault = {
        read: async () => content,
        modify: async (_file: TFile, newContent: string) => {
            content = newContent;
        },
        getAbstractFileByPath: (path: string) => path === file.path ? file : null,
    };

    return {
        context: {
            vault,
            app: {},
            settings: { ...DEFAULT_SETTINGS, wikiPath: 'Wiki' },
        },
        getContent: () => content,
    };
}

function getBody(content: string): string {
    return content.replace(/^---\n[\s\S]*?\n---\n*/, '');
}

const wikiPageWithMetadataBody = `---
title: Page
created: 2026-05-15
updated: 2026-05-15
summary: "Old summary"
tags:
  - old
related:
  []
---
# Page

Original body.

## Summary
Old body summary.

## Tags
- copied-tag

## Related Links
- [[Wiki/Other|Other]]
`;

test('searchWithFallback returns fuzzy results when exact BM25 has no match', () => {
    const files = [
        makeWikiFile('Wiki/Python.md', {
            title: 'Python',
            tags: ['programming'],
            summary: 'High-level programming language',
        }),
    ];
    const engine = new WikiSearchEngine(makeApp(files) as never, { ...DEFAULT_SETTINGS, wikiPath: 'Wiki' });

    engine.build();
    const results = engine.searchWithFallback('pythno', 5);

    assert.equal(results.length, 1);
    assert.equal(results[0].path, 'Wiki/Python.md');
});

test('searchWithFallback uses cached metadata substring fallback after BM25 and fuzzy miss', () => {
    const files = [
        makeWikiFile('Wiki/Machine-Learning.md', {
            title: 'Machine Learning',
            tags: ['ai'],
            summary: 'Models that improve from data',
        }),
    ];
    const engine = new WikiSearchEngine(makeApp(files) as never, { ...DEFAULT_SETTINGS, wikiPath: 'Wiki' });

    engine.build();
    const results = engine.searchWithFallback('learn', 5);

    assert.equal(results.length, 1);
    assert.equal(results[0].title, 'Machine Learning');
});

test('rebuildInBatches indexes 10000 cached wiki pages without reading file bodies', async () => {
    globalThis.window = { setTimeout } as never;
    let readCount = 0;
    const files = Array.from({ length: 10000 }, (_, index) => makeWikiFile(`Wiki/Page-${index}.md`, {
        title: `Page ${index}`,
        tags: ['bulk'],
        summary: `Cached summary ${index}`,
    }));
    const app = makeApp(files, async () => {
        readCount++;
        throw new Error('body read should not be needed');
    });
    const engine = new WikiSearchEngine(app as never, { ...DEFAULT_SETTINGS, wikiPath: 'Wiki' });
    const progress: Array<[number, number]> = [];

    const count = await engine.rebuildInBatches(1000, (indexed, total) => progress.push([indexed, total]));

    assert.equal(count, 10000);
    assert.equal(readCount, 0);
    assert.deepEqual(progress.at(-1), [10000, 10000]);
    assert.equal(engine.search('Page 9999', 1)[0].path, 'Wiki/Page-9999.md');
});

test('list_files paginates large folder results and returns a next cursor', async () => {
    const children = Array.from({ length: 1000 }, (_, index) => new TFile(`Notes/File-${index}.md`));
    const notes = new TFolder('Notes', children);
    const root = new TFolder('', [notes]);
    const vault = {
        root,
        getAbstractFileByPath: (path: string) => path === 'Notes' ? notes : null,
    };

    const first = await listFilesTool.handler(
        { path: 'Notes', limit: 25, extensions: ['md'] },
        { vault, app: {}, settings: DEFAULT_SETTINGS }
    );
    assert.equal(first.success, true);
    const firstData = first.data as { files: string[]; nextCursor: string | null; truncated: boolean };
    assert.equal(firstData.files.length, 25);
    assert.equal(firstData.files[0], 'Notes/File-0.md');
    assert.equal(firstData.files[24], 'Notes/File-24.md');
    assert.equal(firstData.nextCursor, '25');
    assert.equal(firstData.truncated, true);

    const second = await listFilesTool.handler(
        { path: 'Notes', limit: 25, cursor: firstData.nextCursor, extensions: ['md'] },
        { vault, app: {}, settings: DEFAULT_SETTINGS }
    );
    assert.equal(second.success, true);
    const secondData = second.data as { files: string[] };
    assert.equal(secondData.files[0], 'Notes/File-25.md');
});

test('ingest prompt forbids expanding shallow keywords into standalone entries', () => {
    assert.match(INGEST_SYSTEM_PROMPT, /shallow keywords/i);
    assert.match(INGEST_SYSTEM_PROMPT, /Do NOT create a Wiki page merely because a keyword, name, or term appears/i);
    assert.match(INGEST_SYSTEM_PROMPT, /only mentioned once, appears only in a list, tag, heading, quote, citation, or passing reference/i);
    assert.match(INGEST_SYSTEM_PROMPT, /must NOT expand them into standalone entries/i);
});

test('ingest prompt only allows pages for substantively described source topics', () => {
    assert.match(INGEST_SYSTEM_PROMPT, /Only create or update a Wiki page for a topic when the current source document explicitly gives that topic meaningful content/i);
    assert.match(INGEST_SYSTEM_PROMPT, /definition, description, procedure, factual details, relationships, examples, or enough context/i);
    assert.match(INGEST_SYSTEM_PROMPT, /Every created or updated page must be supported by content present in the current source document/i);
});

test('ingest prompt forbids adding explanations outside the source document', () => {
    assert.match(INGEST_SYSTEM_PROMPT, /must NOT introduce any content, information, or knowledge that does not exist in the original source document/i);
    assert.match(INGEST_SYSTEM_PROMPT, /Adding explanations, examples, or details not present in the original/i);
    assert.match(INGEST_SYSTEM_PROMPT, /must NOT add your own explanation, background, examples, or encyclopedia-style details/i);
});

test('Update_Content strips metadata-like sections from body content', async () => {
    const { context, getContent } = makeWritableWikiContext(wikiPageWithMetadataBody);

    const result = await updateContentTool.handler(
        {
            path: 'Wiki/Page.md',
            content: `# Page

Main body.

## Summary
Body summary should not be stored.

## Tags
- body-tag

## Related Links
- [[Wiki/Other|Other]]

## Details
Keep this section.`,
        },
        context
    );

    assert.equal(result.success, true);
    const saved = getContent();
    const body = getBody(saved);
    assert.match(saved, /summary: "Old summary"/);
    assert.match(body, /Main body/);
    assert.match(body, /## Details/);
    assert.doesNotMatch(body, /## Summary/);
    assert.doesNotMatch(body, /## Tags/);
    assert.doesNotMatch(body, /## Related Links/);
});

test('update_wiki_page strips metadata-like sections when replacing and appending body content', async () => {
    const replaceContext = makeWritableWikiContext(wikiPageWithMetadataBody);
    const replaceResult = await updateWikiPageTool.handler(
        {
            path: 'Wiki/Page.md',
            content: `Replacement body.

## Summary
Replacement summary in body.

## Related
- [[Wiki/Other|Other]]`,
        },
        replaceContext.context
    );

    assert.equal(replaceResult.success, true);
    const replacedBody = getBody(replaceContext.getContent());
    assert.match(replacedBody, /Replacement body/);
    assert.doesNotMatch(replacedBody, /## Summary/);
    assert.doesNotMatch(replacedBody, /## Related/);

    const appendContext = makeWritableWikiContext(wikiPageWithMetadataBody);
    const appendResult = await updateWikiPageTool.handler(
        {
            path: 'Wiki/Page.md',
            append: true,
            content: `Appended body.

## Tags
- appended-tag`,
        },
        appendContext.context
    );

    assert.equal(appendResult.success, true);
    const appendedBody = getBody(appendContext.getContent());
    assert.match(appendedBody, /Original body/);
    assert.match(appendedBody, /Appended body/);
    assert.doesNotMatch(appendedBody, /## Summary/);
    assert.doesNotMatch(appendedBody, /## Tags/);
    assert.doesNotMatch(appendedBody, /## Related Links/);
});

test('Update_Summary updates only frontmatter summary and removes body summary section', async () => {
    const { context, getContent } = makeWritableWikiContext(wikiPageWithMetadataBody);

    const result = await updateSummaryTool.handler(
        {
            path: 'Wiki/Page.md',
            summary: 'New frontmatter summary',
        },
        context
    );

    assert.equal(result.success, true);
    const saved = getContent();
    const body = getBody(saved);
    assert.match(saved, /summary: "New frontmatter summary"/);
    assert.doesNotMatch(body, /New frontmatter summary/);
    assert.doesNotMatch(body, /## Summary/);
});

test('Update_Property modifies frontmatter without changing body', async () => {
    const { context, getContent } = makeWritableWikiContext(wikiPageWithMetadataBody);
    const originalBody = getBody(getContent());

    const result = await updatePropertyTool.handler(
        {
            path: 'Wiki/Page.md',
            property: 'tags',
            value: 'alpha,beta',
        },
        context
    );

    assert.equal(result.success, true);
    const saved = getContent();
    assert.match(saved, /  - alpha/);
    assert.match(saved, /  - beta/);
    assert.equal(getBody(saved), originalBody);
});
