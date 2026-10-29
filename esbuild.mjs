import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const builds = tests
  ? [
      {
        ...common,
        entryPoints: ['test/view.test.ts', 'test/host.test.ts', 'test/setup.test.ts', 'test/changes.test.ts', 'test/context.test.ts'],
        outdir: 'out/test',
        platform: 'node',
        format: 'cjs',
        target: 'node20',
      },
    ]
  : [
      {
        ...common,
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        external: ['vscode'],
      },
      {
        ...common,
        entryPoints: ['src/webview/main.js'],
        outfile: 'dist/webview.js',
        platform: 'browser',
        format: 'iife',
        target: 'es2022',
      },
    ];

for (const options of builds) {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
}
