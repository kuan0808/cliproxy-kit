import { plugin } from 'bun';

/**
 * Bun loads a stylesheet as its file path, so `styles.big` in a component under test would read
 * `String.prototype.big` and hand React a function. Load CSS Modules as an object that returns
 * each class name as itself, the way the build's hashed names behave.
 */
plugin({
  name: 'test-loaders',
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
    // An image is its URL, as the build makes it. Left to Bun's default, an .svg imported by a test
    // file over 50 KB comes back from Bun 1.3.9's transpiler cache parsed as JSX on the next run.
    build.onLoad({ filter: /\.svg$/ }, (args) => ({
      exports: { default: args.path },
      loader: 'object',
    }));
  },
});
