# mobdaw Data Policy

**Status:** Draft, for when subscriptions launch. Not fully built yet.
**Last updated:** 2026-10-10

## The policy

1. **Your uploads are yours.** Every audio file belongs to the person who uploaded it, no
   matter which projects it ends up in.
2. **You can delete your uploads at any time.** Deleting one removes it everywhere, including
   from projects you shared it into.
3. **Sharing is not giving away.** Adding your audio to someone else's project lets its
   members play and download it. It doesn't make it theirs. Anything they already
   downloaded stays on their device.
4. **Projects belong to whoever created them.** Deleting a project removes it for every
   member, but doesn't delete anyone's uploads.
5. **Your data is never shared with third parties**, except what you choose to share.
   We don't sell it, and we don't use it for anything except storing it and playing it back
   to you and the people you share it with.
6. **You can download all your data at any time:** your uploads as the original files, and
   your projects.
7. **Cancelling doesn't delete your data right away.** When your subscription ends, your
   account becomes read-only for **30 days**. You can still sign in, play and download
   everything, and resubscribing restores everything as it was.
8. **After 30 days, your data is permanently deleted.** This covers your uploads (including
   in other people's projects), the projects you own, and your account. It can't be recovered.
9. **You can delete your account at any time.** This skips the 30-day window.

## Developer notes

Supersedes the ["Pass 2"](spec.md#pass-2-ownership--access-policy) section of `spec.md`
where they conflict. Main changes:

- Each upload has exactly one owner. Two users uploading identical bytes get two uploads.
  Storage may still dedupe by hash, but that must not affect ownership, deletion or quota.
- Uploaders can delete their uploads, which unlinks them from every project.
- Deleting a project no longer garbage-collects its audio.
- Quota is charged per owner and refunded on delete (today: charged once, to the first uploader).
- New account states: active → read-only (30 days) → purged.
- New: "My uploads" page, full data export, in-app warnings during the 30-day window
  (also shown to members of that user's projects).

## Open questions

- Should deleted uploads go to a trash for a few days first?
- Accounts have no email, so warnings are in-app only. Collect an email?
- Grace period for failed payments?
- Should projects owned by a purged account be deleted, or handed to an editor?
