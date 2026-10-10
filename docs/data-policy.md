# mobdaw Data Policy

**Status:** Draft. This describes how mobdaw *will* handle your data once subscriptions launch.
Parts of it are not built yet; see [Changes from current behavior](#10-changes-from-current-behavior).
**Last updated:** 2026-10-10

---

## 1. The short version

- **Your uploads are yours.** Every audio file belongs to the person who uploaded it, and
  only that person can delete it.
- **You can delete anything you own, any time.** Deleting an upload removes it everywhere,
  including from projects you shared it into.
- **Sharing is not giving away.** Putting your audio in someone else's project, or letting
  someone "save a copy", lets them use it. It does not make it theirs.
- **Cancelling doesn't delete your data right away.** You get **30 days** after your
  subscription ends to download everything. After that, we permanently delete it.
- **You can download all of your data** at any time, including during those 30 days.

---

## 2. Words used in this policy

| Term | Meaning |
|---|---|
| **Account** | Your username, password and settings. |
| **Upload** | An audio file you added to mobdaw. |
| **Project** | A song or session: its arrangement (tracks, clips, effects, automation) plus a list of the audio it uses. |
| **Project owner** | The person who created a project. Each project has exactly one. |
| **Member** | Someone a project owner has invited, as an *editor* or a *viewer*. |
| **Subscription** | Your paid plan. It is what lets you store uploads and own projects. |
| **Retention window** | The 30 days after your subscription ends, when your data is kept so you can download it. |
| **Purge** | Permanent deletion from our storage. Purged data cannot be recovered. |

---

## 3. What you own

| You own... | Because... |
|---|---|
| Every **upload** you made | You uploaded it. This never changes, wherever the audio is used. |
| Every **project** you created | You created it. Ownership can't be transferred (yet). |
| Your **account** | It's yours. |

You do **not** own:

- Audio someone else uploaded, even if it's in your project.
- A project you were invited to, even if you edited it.
- A project you made with "save a copy" owns its *arrangement*, but the audio in it still
  belongs to whoever uploaded it.

If two people upload the exact same file, each person owns their own upload. Deleting one
doesn't affect the other.

---

## 4. How your uploads are shared

When you add an upload to a project, every member of that project can play it and download it.
This is how collaboration works.

- **Members can keep what they downloaded.** Once a file is on someone's computer, we can't
  remove it. Only share audio with people you trust with it.
- **Links expire quickly.** The links we hand out for playing audio stop working after
  **15 minutes**.
- **Leaving a project doesn't take your audio with you.** If you leave, or are removed, the
  uploads you added stay in that project. If you want them gone, delete them (section 5).
- **"Save a copy" shares, it doesn't transfer.** A copy points at the same uploads. If the
  uploader later deletes one, it disappears from the copy too. To keep a file permanently,
  download it and upload it yourself, which makes it *your* upload.

---

## 5. Deleting your data

### Deleting an upload
- Only the uploader can delete an upload.
- It is removed from **every** project that uses it, including projects owned by other people.
  Clips that used it will show as missing audio.
- Before you confirm, mobdaw shows which projects will lose the audio.
- Nobody can play or download it from mobdaw once you confirm. The file is purged from storage
  within **24 hours**.

### Deleting a project
- Only the project owner can delete a project.
- The project, its arrangement and its member list are deleted for everyone, immediately.
- **Uploads are not deleted.** Each upload stays in its owner's library and keeps counting
  toward their storage until they delete it.

### Deleting your account
- You can delete your account at any time. This skips the 30-day retention window.
- We purge everything listed in section 6, step 3, starting immediately.
- Download anything you want to keep first.

---

## 6. When your subscription ends

This applies whether you cancel, or your subscription ends for another reason (for example, a
payment that keeps failing).

| When | What happens | What you can do |
|---|---|---|
| **1. You cancel** | Nothing changes yet. | Everything, until the end of the period you paid for. |
| **2. Subscription ends** (day 0) | Your account becomes **read-only**. Your 30-day retention window starts. Collaborators can still play your audio. | Sign in, play, download all your data, delete things. Resubscribe to restore everything. You can't upload, edit, or create projects. |
| **3. Retention window ends** (day 30) | Your data is **purged**: all your uploads (from every project, including other people's), all projects you own (for every member), and your account. | Nothing. Purged data can't be recovered. |

Things to know:

- **Resubscribe any time before day 30** and everything comes back exactly as it was.
- **Purge finishes within 7 days** of the retention window ending.
- **We'll warn you** in the app during the retention window, showing how many days are left.
- **Your collaborators are affected too.** When your data is purged, your audio disappears from
  their projects, and projects you own are deleted. Members of your projects will see a warning
  during your retention window so they can download what they need.

---

## 7. Downloading your data

You can download a full export at any time, including during the retention window. It contains:

- every upload you own, as the original files
- every project you own (the arrangement, and a list of the audio it uses and who owns it)

It does not contain audio uploaded by other people. You can download those individually
from projects you're a member of, while you still have access.

---

## 8. Who can see your data

- **You** can see everything you own.
- **Project members** can see the projects they belong to, and play and download the audio in
  them.
- **The service operator** can see account details and storage information (file sizes,
  names, which projects use which uploads) to run the service, enforce storage limits and
  fix problems. Your audio is not used for anything except storing it and playing it back to
  you and the people you share it with.

---

## 9. Backups

- We keep **database backups for up to 30 days.** These hold account and project information,
  but not audio files.
- After your data is purged, copies of that information can remain in backups until those backups
  expire. Backups are only used to recover from failures, never to restore purged data.
- **Longest time anything about you can remain:** 30 days (retention window) + 7 days (purge)
  + 30 days (backups) = **67 days** after your subscription ends.

### Key timeframes

| What | How long |
|---|---|
| Playback/download links | 15 minutes |
| Purge after you delete an upload | within 24 hours |
| Retention window after subscription ends | 30 days |
| Purge after the retention window | within 7 days |
| Database backups | 30 days |

---

## 10. Changes from current behavior

*This section is for developers.* It supersedes the
["Pass 2: Ownership & access policy"](spec.md#pass-2-ownership--access-policy) section of
`spec.md` wherever they conflict.

| Topic | Today | Under this policy |
|---|---|---|
| Who owns audio | Samples are shared by reference; nobody owns the bytes. The first uploader is only *charged*. | Each upload has exactly one owner, the uploader. Identical bytes from two users are two uploads. Content-hash dedup in storage is allowed, but is invisible to ownership, deletion and quota. |
| Deleting audio | Not possible. Bytes go only when no project references them. | The uploader can delete an upload. It is unlinked from every project and purged within 24 h. |
| Project delete | Garbage-collects samples with no remaining links. | Deletes the project only. Uploads stay with their owners. |
| Quota | Charged once, to the first uploader, for the sample's lifetime. | Each owner is charged for their own uploads, and refunded when they delete them. |
| "Save a copy" | Copies library links. | Same, but the links point at uploads that remain the uploader's, and that can be deleted by them. |
| Account lifecycle | No subscriptions; accounts never expire. | Active → read-only (30-day retention window) → purged. Resubscribing during the window restores it. |
| Export | Per-sample downloads only. | "Download all my data" export. |

Needed to build this:
- an uploads table owned per user (or an `owner` column per library entry), separate from the
  content-addressed object store
- a "My uploads" page: list, usage (which projects), delete with a confirm that lists affected projects
- account states (`active`, `read_only`, `purging`) and a scheduled purge job
- a full data export
- in-app warnings for a user in their retention window, and for members of their projects
- `admin audit` updated for per-owner quota

---

## 11. Open questions

Defaults are chosen above; these are worth confirming before launch.

1. **Undo for deleting an upload.** Should deleted uploads sit in a trash for a few days
   (e.g. 7) before they're purged, instead of being gone at once?
2. **Notifications.** Accounts have no email address, so warnings are in-app only. Should we
   collect an email for subscription and deletion notices?
3. **Payment failures.** Should a failed payment get a grace period (e.g. 7 days) before the
   subscription counts as ended?
4. **Collaborators keeping audio.** Should a member be able to "adopt" someone else's upload
   (making their own copy, charged to them) in one click, rather than download and re-upload?
5. **Projects owned by a purged account.** Delete them (current default), or let an editor take
   ownership during the retention window?
