import { plugin } from 'bun';

/**
 * Bun loads a stylesheet as its file path, so `styles.big` in a component under test would read
 * `String.prototype.big` and hand React a function. Load CSS Modules as an object that returns
 * each class name as itself, the way the build's hashed names behave.
 */
plugin({
  name: 'css-modules',
  setup(build) {
    build.onLoad({ filter: /\.module\.s?css$/ }, () => ({
      exports: {
        default: new Proxy(
          {},
          { get: (_target, key) => (typeof key === 'string' ? key : undefined) }
        ),
      },
      loader: 'object',
    }));
  },
});
