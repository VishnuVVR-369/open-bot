// @ts-check
/** @param {import("@babel/core").ConfigAPI} api */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    overrides: [
      {
        // Hermes can't parse an async arrow function with a destructured rest parameter
        // (`async (...[input, options = {}]) => …`), which @orpc/client ships.
        // A function, not a RegExp: Metro also loads this config without a filename.
        test: (filename) => !!filename && /node_modules[\\/]@orpc[\\/]/.test(filename),
        plugins: ["@babel/plugin-transform-parameters"],
      },
    ],
  };
};
