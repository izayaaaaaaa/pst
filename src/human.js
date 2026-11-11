// Helpers to keep the pace and input looking like a person.
import { config } from './config.js';

export const rand = (min, max) => min + Math.random() * (max - min);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait a random amount between the configured min and max. */
export const pause = (min = config.minDelayMs, max = config.maxDelayMs) => sleep(rand(min, max));

/** Short pause, e.g. between mouse moves or keystrokes. */
export const beat = () => sleep(rand(120, 450));

/** Scroll down in uneven steps, with the odd small scroll back up. */
export async function scroll(page, { steps = 5 } = {}) {
  for (let i = 0; i < steps; i++) {
    const dy = Math.random() < 0.15 ? -rand(80, 250) : rand(300, 900);
    await page.mouse.wheel(0, dy);
    await sleep(rand(600, 2200));
  }
}

/** Move the mouse to an element in several steps, then click it. */
export async function click(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('Element is not visible, cannot click it');
  const x = box.x + box.width * rand(0.3, 0.7);
  const y = box.y + box.height * rand(0.3, 0.7);
  await page.mouse.move(x, y, { steps: Math.round(rand(8, 25)) });
  await beat();
  await page.mouse.click(x, y, { delay: rand(40, 140) });
}

/** Type text one key at a time with uneven gaps. */
export async function type(page, text) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(rand(60, 220));
  }
}

/** True if `hour` is inside the quiet window (handles windows that wrap past midnight). */
export function inQuietHours(
  hour = new Date().getHours(),
  start = config.quietStartHour,
  end = config.quietEndHour,
) {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
