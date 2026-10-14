# mobdaw

**A multitrack studio in a browser tab, built for playing together.**

Record, loop, sequence, automate and mix with a real audio engine, then share the session and
edit it with other people in real time. Nothing to install. No account to start.

Free and open source under the [Apache License 2.0](LICENSE.md). Invite-only for now.

## Why it's cool

- **Looping, built in.** Loop-station commands (keys or a MIDI foot switch) that are part of the timeline, not a bolt-on.
  Presses land quantized to your click, layers stack onto new tracks, and when you stop, every loop
  is an ordinary clip you can trim, loop or move. Clips loop too.
- **Automation on everything.** Draw automation on any effect or instrument parameter, per track or
  across the whole mix.
- **Click tracks you build.** The metronome is a real track: a drum grid with its own sounds and
  patterns, not a beep with a tempo knob.
- **Real instruments and effects.** Synths, lofi drums, filter / eq, reverb, compressor, tremolo and
  tape delay on every track and on the master bus, in a native-speed Rust/wasm engine running in an
  AudioWorklet.
- **Soundscapes.** Granular, looping sound beds from your own recordings.
- **Made to play together.** Live cursors, chat, shared editing with editor and viewer roles, and
  recording that never collides with a bandmate's take.
- **Things where they belong.** A track's effects live on the track, global effects sit at the top
  of the mix, and what you can do to a clip is under your cursor on the clip.
- **Yours.** Export to audio, or take a whole project as a single file and move it between your
  device and the cloud.

## Free and pro

| | anonymous | account | pro |
|---|---|---|---|
| The whole studio, in your browser | ✓ | ✓ | ✓ |
| Projects and audio stay on your device | ✓ | ✓ | ✓ |
| Open demos and projects shared with you | demos | ✓ | ✓ |
| Cloud projects, on any device | | | ✓ |
| Real-time collaboration | | | ✓ |

Pro is $5 USD / month and pays for cloud storage and collaboration; everything else is free forever.
Details: [`docs/pro-tier.md`](docs/pro-tier.md). How cloud data is handled:
[`docs/data-policy.md`](docs/data-policy.md).

## Try it

Prerequisites: Node 24, and Rust via [rustup](https://rustup.rs) with the wasm target.

```
npm install
cp .env.example .env
npm run admin -- create-user you --admin    # prompts for a password
npm run dev
```

Open http://localhost:5173. Setup details, scripts, repo layout and implementation notes are in
[`docs/development.md`](docs/development.md).

## Docs

- [`docs/development.md`](docs/development.md): setup, scripts, layout, implementation notes
- [`docs/spec.md`](docs/spec.md): server, API, auth, access policy
- [`docs/engine.md`](docs/engine.md), [`docs/engine-api.md`](docs/engine-api.md): the audio engine
- [`docs/dsp.md`](docs/dsp.md): DSP performance and design principles
- [`docs/pro-tier.md`](docs/pro-tier.md), [`docs/data-policy.md`](docs/data-policy.md): plans and data
- [`docs/style.md`](docs/style.md): UI conventions
