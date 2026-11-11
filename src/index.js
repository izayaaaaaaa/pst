// Example run: attach, check login, scroll the feed, then read a few posts from one group.
// Usage: npm start -- <groupIdOrSlug>
import { attach } from './browser.js';
import { config } from './config.js';
import { Budget } from './guard.js';
import { inQuietHours } from './human.js';
import { Facebook } from './fb.js';

if (inQuietHours()) {
  console.log(`Quiet hours (${config.quietStartHour}:00-${config.quietEndHour}:00). Not running.`);
  process.exit(0);
}

const groupArg = process.argv[2];
const { page, detach } = await attach();
const fb = new Facebook(page, new Budget(config.maxPageVisits));

try {
  await fb.home();
  if (!(await fb.isLoggedIn())) {
    console.log('Not logged in. Log in by hand in the Chrome window, then run again.');
  } else {
    await fb.browseFeed(3);

    if (groupArg) {
      await fb.group(groupArg);
      await fb.browseFeed(4);
      const posts = await fb.readPosts(5);
      console.log(`Read ${posts.length} posts:\n`);
      posts.forEach((p, i) => console.log(`--- ${i + 1} ---\n${p.slice(0, 400)}\n`));
    } else {
      console.log('Logged in and attached. To read a group: npm start -- <groupId>');
    }
  }
} catch (err) {
  console.error(`Stopped: ${err.message}`);
  process.exitCode = 1;
} finally {
  await detach();
}
