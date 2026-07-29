console.error(
  "Direct npm pack/publish is disabled for @auto-hwp/react because its source manifest uses file: dependencies.\n" +
    "Use `npm run pack:safe -- [npm pack args]` or `npm run publish:safe -- [npm publish args]`.",
);
process.exit(1);
