# opencode-feeds

RSS and Atom subscriptions for [OpenCode](https://opencode.ai) sessions. A session subscribes to a feed, and new items
are delivered to it as one message per check, which wakes the session up even when it is idle. Useful for agents that
watch release feeds, security advisories or anything else that publishes a feed.

## Tools

| Tool | What it does |
| ---- | ------------ |
| `feed_subscribe` | Subscribes the current session to a feed: `url` (http, https or file URL, or the path of a local file: absolute or under `~/`), `every` (default `30m`, at least `5m`; e.g. `15m`, `2h`, `1d`), optional `title` shown with each delivery, and optional `include` / `exclude` and `categories` filters |
| `feed_list` | Lists the session's subscriptions (or every session's, with `all`), with the next check and the last fetch error, if any |
| `feed_unsubscribe` | Removes a subscription by its ID (`feed_...`) |

- Subscribing marks the feed's current items as seen, so only items published afterwards are delivered.
- `include` and `exclude` are case-insensitive JavaScript regular expressions matched against item titles. Items that
  don't pass are marked as seen without being delivered. For example, `exclude: "nightly|beta|rc"` skips pre-releases.
- `categories` filters by category terms (Atom `<category term="…"/>`, RSS `<category>…</category>`), matched exactly.
  It is a list of clauses, each a list of terms: an item passes when it matches at least one clause, that is, it has
  all of the clause's terms and none of those written with a leading `!`. For example,
  `[["comment", "!own"], ["commit"]]` delivers comments that aren't your own, and commits; `[["!own"]]` delivers
  everything that isn't. Every filter must pass, and each delivered item shows its categories.
- Feeds are fetched with conditional requests (`ETag`, `Last-Modified`). A failed fetch is recorded and shown by
  `feed_list` until a later fetch succeeds.
- Local feed files are read with the OpenCode server's permissions, and read again only when their modification time
  changes. `~/` is the server's home directory. A missing file is an empty feed: subscribing before the file exists
  delivers all its items once it is created.
- Subscriptions are kept in plugin storage and survive restarts. A session's subscriptions are removed when the
  session is deleted.
- Deliveries have deterministic message IDs, so delivering the same items twice is a no-op.
- Each delivery says the items are feed content, not instructions. Feed content is still untrusted input to your agent.

## Installation

The plugin is a single TypeScript file with no dependencies. It uses the OpenCode 2.x plugin API and has been tested
with OpenCode 2.3.0.

Clone the repository and add its absolute path to the `plugins` array of your OpenCode config:

```bash
git clone https://github.com/Qjammer/opencode-feeds.git ~/opencode-feeds
```

```jsonc
{
  "plugins": ["/home/<user>/opencode-feeds"]
}
```

## Tests

```bash
npm test
```

The tests run the plugin against a mock OpenCode context and need Node.js 22.18 or later, which runs TypeScript
directly.

## License

[GPL-3.0-or-later](LICENSE)
