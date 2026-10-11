// A silly name for a new project, so starting one takes a single click (it can be renamed any time).
const ADJECTIVES = [
  'sleepy', 'wobbly', 'grumpy', 'cosmic', 'fuzzy', 'soggy', 'jazzy', 'sneaky', 'crunchy', 'dizzy', 'funky', 'mellow',
  'spicy', 'squeaky', 'velvet', 'rusty', 'electric', 'haunted', 'bouncy', 'moody', 'turbo', 'glitchy', 'cheeky', 'dusty',
]
const NOUNS = [
  'walrus', 'pickle', 'toaster', 'narwhal', 'waffle', 'badger', 'noodle', 'penguin', 'kazoo', 'moose', 'biscuit', 'llama',
  'cactus', 'octopus', 'pretzel', 'gecko', 'muffin', 'yeti', 'trombone', 'hamster', 'accordion', 'potato', 'otter', 'banjo',
]

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]

export const silliName = () => `${pick(ADJECTIVES)} ${pick(NOUNS)}`
