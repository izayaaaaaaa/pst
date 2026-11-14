// Desktop notifications for alerts: build a per-OS command with text passed as arguments
// or environment variables (never spliced into a script), then run it without a shell.
import { spawn as realSpawn } from 'node:child_process';
import { formatMoney } from './rules.js';

/** PowerShell toast script. The text arrives via $env:PST_TITLE and $env:PST_BODY. */
export const WIN_TOAST_SCRIPT = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
  '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  "$xml.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text></text><text></text></binding></visual></toast>')",
  "$t = $xml.GetElementsByTagName('text')",
  '$t.Item(0).AppendChild($xml.CreateTextNode($env:PST_TITLE)) > $null',
  '$t.Item(1).AppendChild($xml.CreateTextNode($env:PST_BODY)) > $null',
  "$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
].join('\n');

/**
 * Replace control characters with spaces, then cut to `max` code points (ending in … when cut).
 * @param {unknown} s
 * @param {number} max
 * @returns {string}
 */
function clean(s, max) {
  const text = String(s ?? '').replace(/\p{Cc}/gu, ' ');
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * @param {string} platform process.platform value
 * @param {string} title
 * @param {string} body
 * @returns {{ cmd: string, args: string[], env: Record<string, string> } | null}
 */
export function buildCommand(platform, title, body) {
  // A leading '-' could be read as an option by osascript/notify-send.
  const t = clean(title, 64).replace(/^-+/, (m) => ' ' + m);
  const b = clean(body, 200).replace(/^-+/, (m) => ' ' + m);
  if (platform === 'darwin') {
    return {
      cmd: 'osascript',
      args: [
        '-e', 'on run argv',
        '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e', 'end run',
        t, b,
      ],
      env: {},
    };
  }
  if (platform === 'win32') {
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', WIN_TOAST_SCRIPT],
      env: { PST_TITLE: t, PST_BODY: b },
    };
  }
  if (platform === 'linux') {
    return { cmd: 'notify-send', args: ['--app-name=pst', '--', t, b], env: {} };
  }
  return null;
}

/**
 * Turn alerts into notifications. More than `max` alerts → the first max−1 one each, then a summary.
 * @param {object[]} alerts
 * @param {{ query: string, max?: number }} opts
 * @returns {{ title: string, body: string }[]}
 */
export function alertsToNotifications(alerts, { query, max = 3 }) {
  const title = `pst · ${query}`;
  const one = (a) => {
    let body = formatMoney(a.price);
    if (a.prevPrice) body += ` (was ${formatMoney(a.prevPrice)})`;
    body += ` · ${a.title ?? ''}`;
    if (a.location) body += ` · ${a.location}`;
    return { title, body };
  };
  if (alerts.length <= max) return alerts.map(one);
  const individual = alerts.slice(0, Math.max(0, max - 1)).map(one);
  const more = alerts.length - individual.length;
  return [...individual, { title, body: `+${more} more alerts for ${query}, see the UI` }];
}

/**
 * Show each notification. Falls back to logging (with a bell) when there is no command for
 * the platform, or when the command fails. Never throws.
 * @param {{ title: string, body: string }[]} notifications
 * @param {{ platform?: string, spawn?: Function, log?: (msg: string) => void }} [opts]
 * @returns {Promise<void>}
 */
export async function notify(notifications, { platform = process.platform, spawn = realSpawn, log = console.log, timeoutMs = 10_000 } = {}) {
  const fallback = (n) => log(`${clean(n.title, 1000)}\n${clean(n.body, 1000)}\x07`);
  for (const n of notifications) {
    const cmd = buildCommand(platform, n.title, n.body);
    if (!cmd) {
      fallback(n);
      continue;
    }
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(cmd.cmd, cmd.args, { env: { ...process.env, ...cmd.env }, stdio: 'ignore' });
        const timer = setTimeout(() => {
          try { child.kill?.(); } catch {}
          reject(new Error('timeout'));
        }, timeoutMs);
        child.once('error', (e) => { clearTimeout(timer); reject(e); });
        child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`exit ${code}`)); });
      });
    } catch {
      fallback(n);
    }
  }
}
