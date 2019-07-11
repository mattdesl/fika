const watch = require('chokidar').watch;
const Emitter = require('events').EventEmitter;

const ignores = [
  'node_modules/**', 'bower_components/**',
  '.git', '.hg', '.svn', '.DS_Store',
  '*.swp', 'thumbs.db', 'desktop.ini'
];

module.exports = function (glob, opt) {
  opt = Object.assign({
    usePolling: opt && opt.poll,
    ignored: ignores,
    ignoreInitial: true
  }, opt);

  const emitter = new Emitter();
  let closed = false;

  const watcher = watch(glob, opt);
  watcher.on('add', onWatch.bind(null, 'add'));
  watcher.on('change', onWatch.bind(null, 'change'));

  function onWatch (event, path) {
    emitter.emit('change', path, { type: event });
  }

  emitter.close = function () {
    if (closed) return;
    watcher.close();
    closed = true;
  };
  return emitter;
};

module.exports.ignores = ignores;
