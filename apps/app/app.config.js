// Adds the build's git commit and time to the app config (read by More > About > Build), so you can tell which version of the
// code is installed on a phone. Everything else comes from app.json. Evaluated every time Expo reads the config, which includes
// the Xcode / Gradle build step that embeds it into the app.
const { execFileSync } = require('node:child_process');

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

module.exports = ({ config }) => {
  const commit = git('rev-parse', '--short', 'HEAD') ?? 'unknown';
  // "+" = tracked files differ from that commit, i.e. the build contains changes that are not committed yet.
  const dirty = git('status', '--porcelain', '--untracked-files=no') ? '+' : '';
  return {
    ...config,
    extra: { ...(config.extra ?? {}), build: { commit: `${commit}${dirty}`, builtAt: new Date().toISOString() } },
  };
};
