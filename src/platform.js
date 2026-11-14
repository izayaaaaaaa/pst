// Per-OS defaults: where Chrome usually lives and where the dedicated profile goes.
// Pure functions (platform, env and home are passed in) so they can be unit tested on any OS.
import os from 'node:os';
import path from 'node:path';

/**
 * Default dedicated profile dir, outside the repo (D-002).
 * Windows: %LOCALAPPDATA%\pst\chrome-profile
 * macOS:   ~/Library/Application Support/pst/chrome-profile
 * Linux:   $XDG_DATA_HOME/pst/chrome-profile (default ~/.local/share)
 */
export function defaultProfileDir(platform = process.platform, env = process.env, home = os.homedir()) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let base;
  if (platform === 'win32') base = env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
  else if (platform === 'darwin') base = p.join(home, 'Library', 'Application Support');
  else base = env.XDG_DATA_HOME || p.join(home, '.local', 'share');
  return p.join(base, 'pst', 'chrome-profile');
}

/** Places to look for the Chrome binary, most likely first. */
export function chromeCandidates(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') {
    const w = path.win32;
    const tail = ['Google', 'Chrome', 'Application', 'chrome.exe'];
    return [
      w.join(env.PROGRAMFILES || 'C:\\Program Files', ...tail),
      w.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', ...tail),
      env.LOCALAPPDATA && w.join(env.LOCALAPPDATA, ...tail),
    ].filter(Boolean);
  }
  if (platform === 'darwin') {
    const bin = path.posix.join('Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
    return [
      path.posix.join('/Applications', bin),
      path.posix.join(home, 'Applications', bin),
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
  ];
}
