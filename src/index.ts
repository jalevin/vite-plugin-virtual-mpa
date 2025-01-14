import ejs from 'ejs';
import path from 'path';
import color from 'cli-color';
import { readFileSync } from 'fs';
import history from 'connect-history-api-fallback';
import { name as pkgName } from '../package.json';
import { Plugin, normalizePath, createFilter } from 'vite';
import { MpaOptions, AllowedEvent, Page, WatchOptions, AllowedEvents } from './utils';

const bodyInject = /<\/body>/;
const pluginName = color.cyan(pkgName);
const issuePath = color.blue('https://github.com/emosheeep/vite-plugin-virtual-mpa/issues/new');

export function createMpaPlugin<
  PN extends string,
  PFN extends string,
  PT extends string,
  Event extends AllowedEvent,
  TPL extends string,
>(
  config: MpaOptions<PN, PFN, PT, Event, TPL>,
): Plugin {
  const {
    template = 'index.html',
    verbose = true,
    pages,
    rewrites,
    watchOptions,
  } = config;

  let inputMap: Record<string, string> = {};
  let virtualPageMap: Record<string, Page<PN, PFN, PT>> = {};

  /**
   * 更新页面配置
   */
  function configInit(pages: typeof config.pages) {
    const [tempInputMap, tempVirtualPageMap]: [typeof inputMap, typeof virtualPageMap] = [{}, {}];
    for (const page of pages) {
      const entryPath = page.filename || `${page.name}.html`;
      if (entryPath.startsWith('/')) {
        throw new Error(`[${pluginName}]: Make sure the path relative, received '${entryPath}'`);
      }
      if (page.name.includes('/')) {
        throw new Error(`[${pluginName}]: Page name shouldn't include '/', received '${page.name}'`);
      }
      if (page.entry && !page.entry.startsWith('/')) {
        throw new Error(`[${pluginName}]: Entry must be an absolute path relative to the project root, received '${page.name}'`);
      }
      tempInputMap[page.name] = entryPath;
      tempVirtualPageMap[entryPath] = page;
    }
    /**
     * 使用新配置直接替换旧的配置
     */
    inputMap = tempInputMap;
    virtualPageMap = tempVirtualPageMap;
  }

  /**
   * 模板文件处理
   */
  function transform(fileContent, id) {
    const page = virtualPageMap[id];
    if (!page) return fileContent;

    return ejs.render(
      !page.entry
        ? fileContent
        : fileContent.replace(
          bodyInject,
          `<script type="module" src="${normalizePath(
            `${page.entry}`,
          )}"></script>\n</body>`,
        ),
      page.data,
    );
  }

  return {
    name: pluginName,
    config() {
      configInit(config.pages); // 初始化

      return {
        appType: 'mpa',
        clearScreen: false,
        optimizeDeps: {
          entries: pages
            .map(v => v.entry)
            .filter(v => !!v) as string[],
        },
        build: {
          rollupOptions: {
            input: inputMap,
          },
        },
      };
    },
    configResolved(config) {
      if (verbose) {
        const colorProcess = path => normalizePath(`<${color.blue(config.build.outDir)}>/${color.green(path)}`);
        const inputFiles = Object.values(inputMap).map(colorProcess);
        console.log(`[${pluginName}]: Generated virtual files: \n${inputFiles.join('\n')}`);
      }
    },
    /**
     * 拦截html请求
     */
    resolveId(id, importer, options) {
      if (options.isEntry && virtualPageMap[id]) {
        return id;
      }
    },
    /**
     * 根据配置映射html文件
     */
    load(id) {
      const page = virtualPageMap[id];
      if (!page) return null;
      return readFileSync(page.template || template, 'utf-8');
    },
    transform,
    configureServer(server) {
      const {
        config,
        watcher,
        middlewares,
        pluginContainer,
        transformIndexHtml,
      } = server;

      const base = normalizePath(`/${config.base || '/'}/`);

      if (watchOptions) {
        const {
          events,
          handler,
          include,
          excluded,
        } = (typeof watchOptions === 'function'
          ? { handler: watchOptions }
          : watchOptions) as WatchOptions<PN, PFN, PT, Event>;

        const isMatch = createFilter(include || /.*/, excluded);

        watcher.on('all', (type: Event, filename) => {
          if (!AllowedEvents.includes(type)) {
            return console.log(
              `[${pluginName}]: Unknown event '${type}'.`,
            );
          }

          if (!isMatch(filename)) return;
          if (events && !events.includes(type)) return;

          const file = path.relative(config.root, filename);

          verbose && console.log(
            `[${pluginName}]: File ${color.blue(file)} fired '${color.blue(type)}' event.`,
          );

          handler({
            type,
            file,
            server,
            reloadPages: configInit,
          });
        });
      }

      middlewares.use(
        // @ts-ignore
        history({
          htmlAcceptHeaders: ['text/html', 'application/xhtml+xml'],
          rewrites: (rewrites || []).concat([
            {
              from: new RegExp(normalizePath(`/${base}/(${Object.keys(inputMap).join('|')})`)),
              to: ctx => normalizePath(`/${inputMap[ctx.match[1]]}`),
            },
          ]),
        }),
      );

      middlewares.use(async (req, res, next) => {
        const accept = req.headers.accept;
        const url = req.url!;

        // 忽略非入口html请求
        if (
          res.writableEnded ||
          accept === '*/*' ||
          !accept?.includes('text/html')
        ) {
          return next();
        }

        // 统一路径，允许直接通过url访问虚拟文件
        const rewritten = url.startsWith(base) ? url : normalizePath(`/${base}/${url}`);
        const fileName = rewritten.replace(base, ''); // 文件名不能以'/'开头，否则无法对应到inputMap，因为inputMap的键是相对路径

        if (verbose && req.originalUrl !== url) {
          console.log(
            `[${pluginName}]: Rewriting ${color.blue(req.originalUrl)} to ${color.blue(rewritten)}`,
          );
        }

        if (!virtualPageMap[fileName]) {
          if (fileName.startsWith('/')) {
            console.log(
              `[${pluginName}]: ${color.red(`filename shouldn't startsWith '/', but received '${fileName}', which may be a bug`)}.`,
              `Please report it at ${issuePath}, thanks!`,
            );
          }
          res.write(`[${pluginName}]: Missing corresponding entry file '${rewritten}', please check your rewrite rules!`);
          res.end();
          return;
        }

        res.end(
          await transformIndexHtml(
            url,
            transform(
              await pluginContainer.load(fileName) as string,
              fileName,
            ),
            req.originalUrl,
          ),
        );
      });
    },
  };
}

// // This is for type declaration testing.
// /* @__PURE__ */createMpaPlugin({
//   template: 'na.html',
//   watchOptions: {
//     include: [],
//     events: ['unlink', 'change'],
//     handler(ctx) {
//       ctx.type;
//       ctx.reloadPages([
//         {
//           name: '123',
//           filename: '////av.abv.v.html.html',
//           template: 'a.b.v',
//         },
//       ]);
//     },
//   },
//   pages: [
//     {
//       name: '123',
//       filename: '////av.abv.v.html.html',
//       template: 'a.b.v',
//     },
//   ],
// });
