// A silly name for a new project, so starting one takes a single click (it can be renamed any time).
const ADJECTIVES = [
  'Sleepy', 'Wobbly', 'Grumpy', 'Cosmic', 'Fuzzy', 'Soggy', 'Jazzy', 'Sneaky', 'Crunchy', 'Dizzy', 'Funky', 'Mellow',
  'Spicy', 'Squeaky', 'Velvet', 'Rusty', 'Electric', 'Haunted', 'Bouncy', 'Moody', 'Turbo', 'Glitchy', 'Cheeky', 'Dusty',
]
const NOUNS = [
  'Walrus', 'Pickle', 'Toaster', 'Narwhal', 'Waffle', 'Badger', 'Noodle', 'Penguin', 'Kazoo', 'Moose', 'Biscuit', 'Llama',
  'Cactus', 'Octopus', 'Pretzel', 'Gecko', 'Muffin', 'Yeti', 'Trombone', 'Hamster', 'Accordion', 'Potato', 'Otter', 'Banjo',
]

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]

export const silliName = () => `${pick(ADJECTIVES)} ${pick(NOUNS)}`
