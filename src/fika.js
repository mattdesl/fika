const ParcelBundler = require('parcel-bundler');
const maxstache = require('maxstache');
const path = require('path');
const titleCase = require('title-case');
const fileWatch = require('./file-watch');
const fs = require('fs');
const terser = require('terser');
const CleanCSS = require('clean-css');
const { promisify } = require('util');
const mkdirp = promisify(require('mkdirp'));
const rimraf = promisify(require('rimraf'));
const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);
const cheerio = require('cheerio');
const defined = require('defined');
const internalIp = require('internal-ip');
const deepEquals = require('deep-equals');
const express = require('express');
const slugify = require('slugify');
const getPort = require('get-port');
const chalk = require('chalk');
const logger = require('@parcel/logger');

module.exports = fika;
async function fika (plugin, opt = {}) {
  const api = opt.api || '1.0.0';
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
  const pluginSlug = slugify(path.basename(srcDir));
  const name = opt.name || titleCase(pluginSlug);
  const minify = defined(opt.minify, Boolean(isBuild));

  await mkdirp(srcDir);
  if (opt.writePackgeJSON !== false) await writePackageJSON(cwd);
  if (opt.writeGitIgnore !== false) await writeGitIgnore(cwd);

  // needed for parcel to output correct directory structures :(
  if (!fs.existsSync(pluginIndex)) {
    await writeFile(pluginIndex, `<p>This file is generated by fika and used internally. You probably want to look within the plugin folders for individual HTML files.</p>\n`);
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

  const bundlerOpts = {
    outDir,
    sourceMaps: false,
    autoInstall: false,
    minify,
    target: opt.target || 'browser',
    watch: defined(opt.watch, !isBuild),
    https: opt.https || false,
    contentHash: false,
    logLevel: 3,
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
    result.stop = async () => bundler.stop();
    return result;
  } else {
    const app = express();

    if (opt.index !== false) {
      if (manifest.ui) {
        // Redirect index to plugin UI if it exists
        const pluginOutUI = path.join(pluginOutDir, manifest.ui);
        const relativeOutFile = path.relative(outDir, pluginOutUI);
        const routeUrl = relativeOutFile
          .replace(/[\\/]/g, '/')
          .replace(/^[/]?/, '/');
        app.use((req, res, next) => {
          if (req.url === '/' || /index.html?/i.test(req.url)) {
            res.status(301).redirect(routeUrl);
          } else {
            next(null);
          }
        });
      } else {
        app.use((req, res, next) => {
          if (req.url === '/') {
            res.set('Content-Type', 'text/html');
            const msg = `<p>This plugin doesn't have any UI, so you'll have to test in Figma!</p>`;
            res.send(msg);
          } else {
            next(null);
          }
        });
      }
    } else {
      app.use((req, res, next) => {
        // weird parcel bug?
        if (req.url === '/') {
          req.url = '/index.html';
        }
        next(null);
      });
    }

    app.use(bundler.middleware());

    let defaultPort = parseInt(defined(opt.port, process.env.PORT, 9966), 10);
    const port = await getPort({ port: defaultPort });

    const server = await new Promise((resolve, reject) => {
      const noop = () => {};
      app.once('error', err => {
        reject(err);
      });
      const server = app.listen(port, () => {
        resolve(server);
        reject = noop;
      });
    });

    const { local, host } = await getHostAddress(server);
    const localUrl = `http://localhost:${port}/`;
    const hostUrl = `http://${host}:${port}/`;
    const url = local ? localUrl : hostUrl;
    const urls = (local && localUrl !== hostUrl) ? [
      localUrl,
      hostUrl
    ] : [ url ];

    printLogMessage(pluginSlug, urls, defaultPort, port);

    return {
      ...result,
      async stop () {
        await bundler.stop();
        server.close();
      },
      url,
      urls,
      server,
      host,
      port
    };
  }

  function printLogMessage (slug, urls, defaultPort, port) {
    let portMatches = port === defaultPort;
    urls = urls
      .map(u => chalk.bold(chalk.cyan(u)))
      .map(u => `    ${u}`)
      .join('\n');

    const portMsg = portMatches ? '' : chalk.red(`ERROR: Port ${defaultPort} is in use, using ${chalk.cyan(port)} instead\n`)
    const msg = `Development server for ${chalk.magenta(slug)} running at:`
    logger.persistent(`${portMsg}${chalk.bold(msg)}

${urls}

Enter Ctrl + C in your shell to stop the server.\n`);
  }

  function gatherEntries (manifest) {
    return [ manifest.ui, manifest.main ].filter(Boolean);
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
    if (newManifest.ui) {
      newManifest.ui = newManifest.ui.replace(/\.html?$/i, '.ui.html');
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
      if (manifest.main) {
        modifying = true;
        const entryFile = path.join(pluginOutDir, manifest.main);
        const input = await readFile(entryFile, 'utf-8');
        if (modifying && input.trim()) {
          let modified = replaceRequire(input);
          if (minify) {
            modified = minifyJS(modified);
          }
          await writeFile(entryFile, modified);
        }
      }
      if (manifest.ui) {
        modifying = true;
        const htmlFile = path.join(pluginOutDir, manifest.ui);
        const input = await readFile(htmlFile, 'utf-8');
        if (modifying && input.trim()) {
          const { html, filesToRemove } = await inlineHTML(input, outDir, pluginOutDir, minify);
          if (modifying) {
            await writeFile(htmlFile.replace(/\.html?$/i, '.ui.html'), html);
            if (isBuild) {
              await Promise.all([ htmlFile, ...filesToRemove ].map(f => rimraf(f)));
            }
          }
        }
      }
      modifying = false;
    });
  }

  async function safeWrite (file, data) {
    if (!force && fs.existsSync(file)) {
      throw new Error(`The file ${path.relative(cwd, file)} exists. Use --force if you want to overwrite all files`);
    }
    return writeFile(file, data);
  }

  async function runInit () {
    const manifest = {
      name,
      api
    };
    if (opt.main !== false) {
      manifest.main = `${pluginSlug}.main${ext}`;
    }
    if (opt.ui !== false) {
      manifest.ui = `${pluginSlug}.html`;
    }

    const scriptFile = manifest.main ? path.join(srcDir, manifest.main) : null;
    const htmlFile = manifest.ui ? path.join(srcDir, manifest.ui) : null;
    const manifestFile = path.join(srcDir, `manifest.json`);
    await safeWrite(manifestFile, JSON.stringify(manifest, null, 2));
    if (scriptFile) {
      const templateFileName = htmlFile ? 'plugin-with-ui.js' : 'plugin.js';
      const scriptSrc = await readFile(path.join(__dirname, 'templates', templateFileName));
      await safeWrite(scriptFile, scriptSrc);
    }
    if (htmlFile) {
      const rendererFile = `${pluginSlug}.ui${ext}`;
      const htmlRendererFile = path.join(srcDir, rendererFile);
      const htmlIn = await readFile(path.join(__dirname, 'templates/ui.html'), 'utf-8');
      const htmlSrc = maxstache(htmlIn, {
        title: pluginSlug,
        entry: JSON.stringify(encodeURI(rendererFile))
      });
      const rendererSrc = await readFile(path.join(__dirname, 'templates/ui.js'));
      await safeWrite(htmlFile, htmlSrc);
      await safeWrite(htmlRendererFile, rendererSrc);
    }
  }
}

async function writePackageJSON (dir) {
  const file = path.join(dir, 'package.json');
  if (!fs.existsSync(file)) {
    await writeFile(file, JSON.stringify({
      name: slugify(path.basename(dir)),
      version: '1.0.0',
      description: 'A Figma plugin',
      scripts: {
      },
      keywords: [],
      browserslist: [
        'last 1 Chrome version'
      ]
    }, null, 2));
  }
}

async function writeGitIgnore (dir) {
  const file = path.join(dir, '.gitignore');
  if (!fs.existsSync(file)) {
    await writeFile(file, `node_modules
*.log
.DS_Store
bundle.js
.cache
dist/\n`);
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
