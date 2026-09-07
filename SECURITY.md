# Security

Reflect runs entirely on your machine and serves an **unauthenticated API on
loopback**. Anything able to reach `127.0.0.1` on its port can read and write
your memory. That is the same trust boundary as any local development server,
and it is why `REFLECT_HOST` defaults to loopback — setting it to `0.0.0.0`
exposes that API to your whole network, and you should not.

## What the app does about it

- **Outbound requests are guarded.** Addresses are resolved and checked before
  each fetch and again on every redirect hop, so a hostname that resolves to a
  private range or to the cloud metadata service at `169.254.169.254` is
  refused. See `src/web/Safety.js`.
- **Tools are absent rather than refused.** Web tools do not exist unless the
  web is on; file tools do not exist unless a folder is connected; the
  messaging tool does not exist until you have added someone. A tool the model
  cannot see cannot be talked into being called by a page it just read.
- **Tasks run with less authority than you do.** A scheduled task holds only
  what its own instruction asked for, because nobody is watching it run.
- **Everything that leaves is counted**, at the socket, in `~/.reflect/ledger.jsonl`.

## Reporting something

Open an issue. If it is sensitive, say so in the title without the details and
we will find somewhere better to talk.

## What is not protected

The builds are unsigned. Nothing verifies that a copy you downloaded is the one
that was published, so get it from this repository.
