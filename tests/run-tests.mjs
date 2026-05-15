import esbuild from 'esbuild';
import { mkdir, rm } from 'fs/promises';
import { spawn } from 'child_process';
import { join } from 'path';

const outdir = '.tmp-tests';
const outfile = join(outdir, 'wikichat.test.cjs');

const obsidianMock = `
class TFile {
  constructor(path, options = {}) {
    this.path = normalizePath(path);
    this.name = this.path.split('/').pop() || this.path;
    this.extension = options.extension ?? (this.name.includes('.') ? this.name.split('.').pop() : '');
    this.basename = options.basename ?? this.name.replace(/\\.[^.]+$/, '');
    this.stat = options.stat ?? { ctime: Date.now(), size: 0 };
    this.cache = options.cache;
  }
}

class TFolder {
  constructor(path, children = []) {
    this.path = normalizePath(path);
    this.name = this.path.split('/').pop() || this.path;
    this.children = children;
  }
}

function normalizePath(path) {
  return String(path ?? '').replace(/\\\\/g, '/').replace(/\\/+/g, '/').replace(/^\\.\\//, '').replace(/\\/$/, '');
}

module.exports = { TFile, TFolder, normalizePath };
`;

const obsidianMockPlugin = {
    name: 'obsidian-mock',
    setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian-mock', namespace: 'obsidian-mock' }));
        build.onLoad({ filter: /.*/, namespace: 'obsidian-mock' }, () => ({
            contents: obsidianMock,
            loader: 'js',
        }));
    },
};

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await esbuild.build({
    entryPoints: ['tests/wikichat.test.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile,
    plugins: [obsidianMockPlugin],
});

const child = spawn(process.execPath, ['--test', outfile], { stdio: 'inherit' });
const code = await new Promise((resolve) => child.on('exit', resolve));
await rm(outdir, { recursive: true, force: true });

if (code !== 0) {
    process.exit(code ?? 1);
}
