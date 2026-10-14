import { h } from '../dom'

const KEY = 'mobdaw.about'

/** The about column on the home page: what mobdaw is, who gets what, and what makes it different. */
export function aboutColumn(): { el: HTMLElement; toggle(): void } {
  const el = h('aside', { className: 'about' },
    h('h2', {}, 'mobdaw'),
    h('p', {}, 'a multitrack studio that lives in a browser tab: record, loop, sequence, automate and mix, then share the session and play it together in real time.'),
    h('p', { className: 'dim' }, 'invite-only for now.'),

    h('h3', {}, 'who gets what'),
    h('dl', {},
      h('dt', {}, 'anonymous'),
      h('dd', {}, 'no account, no cost. the whole studio runs in your browser, and your projects and audio stay on your device: nothing is sent to us. export a project to a file whenever you like. you can also open any demo.'),
      h('dt', {}, 'account'),
      h('dd', {}, 'sign in with an invite. open projects that are shared with you and the public ones, and carry your work with you.'),
      h('dt', {}, 'pro'),
      h('dd', {}, 'cloud projects and real-time collaboration: your audio is stored for you, available on any device, and you edit the same session with others, as editors or viewers.')),

    h('h3', {}, 'what it does'),
    h('ul', {},
      h('li', {}, h('strong', {}, 'looping built in. '), 'loop-station commands (keys or a MIDI foot switch) that are part of the timeline, not a bolt-on: loops land on the cycle, layer onto the next track, and are ordinary clips you can edit; a mute is volume automation, so replaying the song replays it. clips can loop, too.'),
      h('li', {}, h('strong', {}, 'deep automation. '), 'draw automation on any effect or instrument parameter, per track or across the whole mix.'),
      h('li', {}, h('strong', {}, 'click tracks you build. '), 'the metronome is a real track: a drum grid with its own sounds and patterns, not a beep you can only speed up.'),
      h('li', {}, h('strong', {}, 'real instruments and effects. '), 'synths, lofi drums, filter / eq, reverb, compressor, tremolo and tape delay, on every track and on the master bus, running in a native-speed audio engine.'),
      h('li', {}, h('strong', {}, 'soundscapes. '), 'granular, looping sound beds built from your own recordings.'),
      h('li', {}, h('strong', {}, 'made to play together. '), 'live cursors, chat, and recording that never collides with a bandmate\'s take.'),
      h('li', {}, h('strong', {}, 'yours. '), 'free and open source. export to audio, or take your whole project as a file.')),

    h('h3', {}, 'how it feels'),
    h('p', {}, 'the interface puts things where they belong: a track\'s effects live on the track, master effects sit at the top of the mix, and everything you can do to a clip is under your cursor on the clip. no hunting through menus, no modes to remember.'))
  el.hidden = localStorage.getItem(KEY) !== 'open'
  return {
    el,
    toggle() {
      el.hidden = !el.hidden
      localStorage.setItem(KEY, el.hidden ? 'closed' : 'open')
    },
  }
}
