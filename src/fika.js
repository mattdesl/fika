const ParcelBundler = require('parcel-bundler');
const path = require('path');
const fileWatch = require('./file-watch');
const fs = require('fs');
const terser = require('terser');
const CleanCSS = require('clean-css');
const { promisify } = require('util');
const mkdirp = promisify(require('mkdirp'));
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const cheerio = require('cheerio');
const defined = require('defined');
const internalIp = require('internal-ip');
const deepEquals = require('deep-equals');

module.exports = fika;
async function fika (plugin, opt = {}) {
  const apiVersion = opt.apiVersion || '0.5.0';
  const cwd = process.cwd();
  const ext = opt.ts ? '.ts' : '.js';
  let {
    init = false,
    force = false,
    outDir = path.join(cwd, 'dist')
  } = opt;

  outDir = path.isAbsolute(outDir) ? outDir : path.resolve(cwd, opt.outDir);
  let srcDir;
  let pluginDir = path.dirname(plugin);
  if ([ '', '/', '.' ].includes(pluginDir)) {
    pluginDir = 'src';
    plugin = path.join(pluginDir, plugin);
  }
  srcDir = path.isAbsolute(plugin) ? plugin : path.resolve(cwd, plugin);

  if (outDir === srcDir) {
    throw new Error(`Plugin ${plugin} can't be the same as the out dir`);
  }
  if (!init && !fs.existsSync(srcDir)) {
    throw new Error(`Plugin ${plugin} doesn't exist, maybe you'd like to use the --init flag to create it?`);
  }

  const isBuild = opt.build;
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = isBuild ? 'production' : 'development';
  }

  const pluginIndex = path.join(pluginDir, 'index.html');
  const pluginSlug = path.basename(srcDir);
  const name = opt.name || pluginSlug;
  const minify = defined(opt.minify, Boolean(isBuild));

  await mkdirp(srcDir);

  // needed for parcel to output correct directory structures :(
  if (!fs.existsSync(pluginIndex)) {
    await writeFile(pluginIndex, `<p>You probably want to look within the plugin folder!</p>\n`);
  }

  if (init) {
    await runInit();
  }

  const pluginOutDir = path.join(outDir, pluginSlug);
  await mkdirp(pluginOutDir);

  const manifestFile = path.join(srcDir, 'manifest.json');
  const manifestOutFile = path.join(pluginOutDir, 'manifest.json');
  let manifest = await readManifest();
  const initialManifestEntries = gatherEntries(manifest);
  const entries = [
    pluginIndex,
    ...initialManifestEntries.map(f => path.relative(cwd, path.join(srcDir, f)))
  ];

  await updateManifest();

  const port = defined(opt.port, 9966);
  const bundlerOpts = {
    outDir,
    sourceMaps: false,
    autoInstall: false,
    minify,
    target: opt.target || 'browser',
    watch: defined(opt.watch, !isBuild),
    https: opt.https || false,
    contentHash: false,
    logLevel: 4,
    hmr: defined(opt.hmr, !isBuild)
  };

  const bundler = new ParcelBundler(entries, bundlerOpts);

  if (bundlerOpts.watch) {
    watchManifest();
  }

  handleBundlerEvents();

  const result = {
    bundler
  };

  if (isBuild) {
    const build = await bundler.bundle();
    result.build = build;
    return result;
  } else {
    const server = await bundler.serve(port);

    const { local, host } = await getHostAddress(server);
    const localUrl = `http://localhost:${port}/`;
    const hostUrl = `http://${host}:${port}/`;
    const url = local ? localUrl : hostUrl;
    const urls = (local && localUrl !== hostUrl) ? [
      localUrl,
      hostUrl
    ] : [ url ];

    return {
      ...result,
      url,
      urls,
      server,
      host,
      port
    };
  }

  function gatherEntries (manifest) {
    return [ manifest.html, manifest.script ].filter(Boolean);
  }

  function watchManifest () {
    const watcher = fileWatch(manifestFile);
    let isCurrentlyBundling = false;
    bundler.on('buildStart', () => {
      isCurrentlyBundling = true;
    });

    bundler.on('buildEnd', () => {
      isCurrentlyBundling = false;
    });
    watcher.on('change', async () => {
      manifest = await readManifest();
      const newEntries = gatherEntries(manifest);
      if (!deepEquals(newEntries, initialManifestEntries)) {
        throw new Error(`The manifest.json has new entries, you'll have to re-start the build!`)
      }
      await updateManifest();
      // trigger a new dev build if necessary
      if (!isCurrentlyBundling && !isBuild) {
        bundler.bundle();
      }
    });
  }

  async function updateManifest () {
    const newManifest = JSON.parse(JSON.stringify(manifest));
    if (newManifest.html) {
      newManifest.html = newManifest.html.replace(/\.html?$/i, '.inline.html');
    }
    await writeFile(manifestOutFile, JSON.stringify(newManifest, null, 2));
  }

  async function readManifest () {
    const text = await readFile(manifestFile, 'utf-8');
    return JSON.parse(text);
  }

  function handleBundlerEvents () {
    let modifying = false;
    bundler.on('buildStart', () => {
      modifying = false;
    });
    bundler.on('buildEnd', async () => {
      if (manifest.script) {
        modifying = true;
        const entryFile = path.join(pluginOutDir, manifest.script);
        const input = await readFile(entryFile, 'utf-8');
        if (modifying && input.trim()) {
          let modified = replaceRequire(input);
          if (minify) {
            modified = minifyJS(modified);
          }
          await writeFile(entryFile, modified);
        }
      }
      if (manifest.html) {
        modifying = true;
        const htmlFile = path.join(pluginOutDir, manifest.html);
        const input = await readFile(htmlFile, 'utf-8');
        if (modifying && input.trim()) {
          const { html } = await inlineHTML(input, outDir, pluginOutDir, minify);
          if (modifying) {
            await writeFile(htmlFile.replace(/\.html?$/i, '.inline.html'), html);
          }
        }
      }
      modifying = false;
    });
  }

  async function safeWrite (file, data) {
    if (!force && fs.existsSync(file)) {
      throw new Error(`The file ${path.relative(cwd, file)} exists. Use --force if you want to overwrite`);
    }
    return writeFile(file, data);
  }

  async function runInit () {
    const manifest = {
      name,
      version: apiVersion
    };
    if (opt.script !== false) {
      manifest.script = `${pluginSlug}${ext}`;
    }
    if (opt.html !== false) {
      manifest.html = `${pluginSlug}.html`;
    }

    const scriptFile = manifest.script ? path.join(srcDir, manifest.script) : null;
    const htmlFile = manifest.html ? path.join(srcDir, manifest.html) : null;
    const manifestFile = path.join(srcDir, `manifest.json`);
    // TODO: fill in templates
    await safeWrite(manifestFile, JSON.stringify(manifest, null, 2));
    if (scriptFile) await safeWrite(scriptFile, '/* The main script */\n');
    if (htmlFile) {
      const rendererFile = `${pluginSlug}.renderer${ext}`;
      const htmlRendererFile = path.join(srcDir, rendererFile);
      await safeWrite(htmlFile, `<html>\n  <body>\n    <script src="${rendererFile}"></script>\n  </body>\n</html>\n`);
      await safeWrite(htmlRendererFile, `/* The renderer script */\n`);
    }
  }
}

function urlToPath (distDir, curDir, url) {
  if (url.startsWith('/')) return path.join(distDir, url);
  else return path.join(curDir, url);
}

async function minifyCSS (code) {
  const output = await (new CleanCSS({ returnPromise: true }).minify(code));
  if (output.errors) {
    output.errors.forEach(err => console.error(err));
  }
  if (output.warnings) {
    output.warnings.forEach(err => console.error(err));
  }
  return output.styles;
}

function minifyJS (code) {
  return terser.minify(code, {
    sourceMap: false,
    output: { comments: false },
    compress: {
      keep_infinity: true,
      pure_getters: true
    },
    warnings: true,
    ecma: 5,
    toplevel: false,
    mangle: {
      properties: false
    }
  }).code;
}

async function inlineHTML (html, distDir, curDir, minify) {
  const $ = cheerio.load(html);
  const scripts = $('script').toArray();
  const filesToRemove = [];
  await Promise.all(scripts.map(async cur => {
    const el = $(cur);
    const src = el.attr('src');
    if (src && !isAbsolute(src)) {
      const filePath = urlToPath(distDir, curDir, src);
      filesToRemove.push(filePath);
      filesToRemove.push(`${filePath}.map`);
      const scriptIn = await readFile(filePath, 'utf-8');
      let scriptModified = replaceRequire(scriptIn);
      if (minify) {
        scriptModified = minifyJS(scriptModified);
      }
      el.removeAttr('src');
      el.replaceWith(`<script>\n${scriptModified}\n</script>`);
    }
  }));

  const links = $('link').toArray();
  await Promise.all(links.map(async cur => {
    const el = $(cur);
    const src = el.attr('href');
    if (src && !isAbsolute(src)) {
      const filePath = urlToPath(distDir, curDir, src);
      filesToRemove.push(filePath);
      filesToRemove.push(`${filePath}.map`);
      let styleIn = await readFile(filePath, 'utf-8');
      if (minify) {
        styleIn = await minifyCSS(styleIn);
      }
      el.replaceWith(`<style>\n${styleIn}\n</style>`);
    }
  }));
  return {
    html: $.html(),
    filesToRemove
  };
}

function isAbsolute (url) {
  return ['https://', 'http://', '//'].some(prefix => {
    return url.startsWith(prefix);
  });
}

async function getHostAddress (server, host = null) {
  const internal = await internalIp.v4();

  // user can specify "::" or "0.0.0.0" as host exactly
  // or if undefined, default to internal-ip
  if (!host) {
    host = server.address().address;
    if (host === '0.0.0.0') {
      // node 0.10 returns this when no host is specified
      // node 0.12 returns internal-ip
      host = '::';
    }
  }
  if (host === '::') {
    host = internal;
  }
  if (!host) {
    host = '127.0.0.1';
  }
  let local = ['localhost', '127.0.0.1', '0.0.0.0', internal].includes(host);
  return { local, host };
}

function replaceRequire (str) {
  return str
    .replace('var parcelRequire', 'parcelRequire')
    .replace('parcelRequire', 'var parcelRequire');
}
