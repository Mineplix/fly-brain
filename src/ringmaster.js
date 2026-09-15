// A ringmaster for the circus arena: announces adventures, restages the arena between them,
// and reacts to what the flies actually do.
//
// It is deliberately *narration plus stagecraft only*. It never touches a connectome -- there
// is a `stimulate` hook on the fly workers that could excite named circuits directly, and it is
// not used here, so every behaviour you see remains a genuine result of the simulated brain.
//
// It only restages things flies sense through `env`: food, odour plumes, bitter, heat, wind,
// light and the looming threat. It never adds obstacles: the MuJoCo world is built when a fly
// is created, so a new obstacle would be *sensed* by existing flies (clearance() reads
// env.obstacles live) while not physically existing for them.
//
// Cost is a DOM banner and a few comparisons per pose message. No GPU work, no worker traffic
// beyond the env sync an adventure already implies.

const pick = a => a[(Math.random() * a.length) | 0];

// --- voice -------------------------------------------------------------------------------
const OPENING = [
  'Welcome, welcome, one and all, to the greatest show ever simulated!',
  'Step right up! Six brains, one ring, no refunds!',
  'Ladies, gentlemen and larvae - the show begins!',
];
const ADVENTURE_CALL = [
  'And now… an ADVENTURE!',
  'Who fancies an adventure? Nobody? Marvellous, let us begin!',
  'Time for something completely different!',
  'Drumroll, if you please —',
];
const IDLE = [
  'Take your time. The void is patient.',
  'Magnificent. Truly, the pinnacle of insect achievement.',
  'Somebody is going to do something delightful any moment now. I can feel it.',
  'Ah, the quiet dignity of standing perfectly still.',
  'One hundred and sixty-five thousand neurons, and this is the plan.',
];

// Reactions keyed by the behaviour label the sim emits.
const ON_BEHAVIOUR = {
  'feeding': [
    '{name} has found the good stuff!',
    'Look at {name} go! An appetite worth applauding.',
    'Dinner is served for {name}.',
  ],
  'grooming': [
    '{name} pauses for personal grooming. Showmanship!',
    'Presentation matters, and {name} knows it.',
  ],
  'courting': [
    'Oho! {name} has noticed somebody.',
    'Romance blooms in the big top. Go on, {name}.',
  ],
  'singing (courtship)': [
    '{name} is SINGING. Somebody fetch a bouquet!',
    'That, my friends, is a love song played on a wing.',
  ],
  'escape jump': [
    'AND {name} IS GONE! What reflexes!',
    '{name} exits stage up. A giant-fibre special!',
  ],
  'taking off': [
    '{name} takes to the air!',
    'Up, up goes {name}!',
  ],
  'flying': [
    '{name} is airborne, and frankly showing off.',
  ],
  'righting': [
    '{name} has fallen over. {name} is dealing with it.',
    'A tumble! And a recovery! All part of the act.',
  ],
  'walking backward': [
    '{name} reverses. Bold. Unorthodox. Possibly a mistake.',
  ],
  'dead': [
    'Oh. Oh dear. A moment of silence for {name}.',
    '{name} has left the show permanently. The circus continues.',
  ],
};

// --- adventures --------------------------------------------------------------------------
// Each restages the arena using only live-safe env fields.
const R = 2.5;
const ring = (n, r, f) => Array.from({ length: n }, (_, k) => { const a = k * 2 * Math.PI / n + Math.random(); return f(r * Math.cos(a), r * Math.sin(a)); });

const ADVENTURES = [
  {
    name: 'The Great Sugar Hunt',
    line: 'Today: THE GREAT SUGAR HUNT! Five prizes, hidden in plain sight!',
    apply: env => {
      env.food = ring(5, 1.6, (x, y) => ({ x, y, r: 0.22, sugar: 1, bitter: 0, water: 0.2, amount: 4 }));
      env.odors = env.food.map(f => ({ x: f.x, y: f.y, odor: 'vinegar', strength: 0.8, sigma: 0.6 }));
      env.bitterPatches = []; env.hazards = []; env.wind = [0, 0];
    },
  },
  {
    name: 'The Bitter Truth',
    line: 'This round, most of it is a LIE. Choose wisely!',
    apply: env => {
      env.food = [{ x: 1.4, y: -0.8, r: 0.24, sugar: 1, bitter: 0, water: 0.2, amount: 5 }];
      env.bitterPatches = ring(4, 1.3, (x, y) => ({ x, y, r: 0.3, bitter: 1 }));
      env.odors = [{ x: 1.4, y: -0.8, odor: 'vinegar', strength: 0.9, sigma: 0.8 }];
      env.hazards = []; env.wind = [0, 0];
    },
  },
  {
    name: 'The Floor Is Lava',
    line: 'THE FLOOR IS LAVA! Not metaphorically. Please mind your tarsi.',
    apply: env => {
      env.hazards = ring(3, 1.2, (x, y) => ({ x, y, r: 0.42, heat: 1 }));
      env.food = [{ x: 0, y: 1.9, r: 0.26, sugar: 1, bitter: 0, water: 0.3, amount: 6 }];
      env.odors = [{ x: 0, y: 1.9, odor: 'vinegar', strength: 1, sigma: 1 }];
      env.bitterPatches = []; env.wind = [0, 0];
    },
  },
  {
    name: 'A Stiff Breeze',
    line: 'Weather! I have invented weather! Hold on to something!',
    apply: env => {
      const a = Math.random() * 2 * Math.PI;
      env.wind = [14 * Math.cos(a), 14 * Math.sin(a)];
      env.food = ring(3, 1.5, (x, y) => ({ x, y, r: 0.24, sugar: 1, bitter: 0, water: 0.2, amount: 4 }));
      env.odors = env.food.map(f => ({ x: f.x, y: f.y, odor: 'vinegar', strength: 1, sigma: 1.1 }));
      env.hazards = []; env.bitterPatches = [];
    },
  },
  {
    name: 'Lights Down',
    line: 'Lights down! Let us see who was paying attention to their other senses.',
    apply: env => {
      env.light.sky = 0.12;
      env.food = ring(4, 1.4, (x, y) => ({ x, y, r: 0.26, sugar: 1, bitter: 0, water: 0.2, amount: 4 }));
      env.odors = env.food.map(f => ({ x: f.x, y: f.y, odor: 'vinegar', strength: 1.2, sigma: 1.2 }));
      env.hazards = []; env.bitterPatches = []; env.wind = [0, 0];
    },
    restore: env => { env.light.sky = 1; },
  },
  {
    name: 'Something Wicked',
    line: 'Does anyone else hear that? No? Just me? …Just me.',
    threat: true,
    apply: env => {
      env.food = [{ x: -1.5, y: -1.2, r: 0.3, sugar: 1, bitter: 0, water: 0.3, amount: 6 }];
      env.odors = [{ x: -1.5, y: -1.2, odor: 'vinegar', strength: 1, sigma: 1 }];
      env.hazards = []; env.bitterPatches = []; env.wind = [0, 0];
    },
  },
  {
    name: 'The Dungeon',
    line: 'The big top is GONE. Welcome to the dungeon. Mind the flagstones.',
    look: 'dungeon',
    apply: env => {
      env.light.sky = 0.35;
      env.obstacles = [
        { type: 'cylinder', x: -0.8, y: 0.9, r: 0.16, sz: 0.9 },
        { type: 'cylinder', x: 0.9, y: 0.8, r: 0.16, sz: 0.9 },
        { type: 'cylinder', x: -0.9, y: -0.8, r: 0.16, sz: 0.9 },
        { type: 'box', x: 0.4, y: -1.3, sx: 0.9, sy: 0.08, sz: 0.45 },
      ];
      env.food = [{ x: 1.7, y: -1.5, r: 0.26, sugar: 1, bitter: 0, water: 0.3, amount: 6 }];
      env.odors = [{ x: 1.7, y: -1.5, odor: 'vinegar', strength: 1.2, sigma: 1.3 }];
      env.hazards = []; env.bitterPatches = []; env.wind = [0, 0];
    },
    restore: env => { env.light.sky = 1; env.obstacles = []; },
  },
  {
    name: 'The Sunken Cavern',
    line: 'Down, down, down we go. It is damp. I did warn you. I did not warn you.',
    look: 'cavern',
    apply: env => {
      env.light.sky = 0.28; env.humidity = 0.9;
      env.obstacles = [
        { type: 'cylinder', x: 0.2, y: 1.2, r: 0.22, sz: 0.7 },
        { type: 'cylinder', x: -1.2, y: -0.3, r: 0.28, sz: 0.55 },
      ];
      env.food = [{ x: -1.4, y: 1.3, r: 0.3, sugar: 1, bitter: 0, water: 0.9, amount: 6 }];
      env.odors = [{ x: -1.4, y: 1.3, odor: 'vinegar', strength: 1, sigma: 1.4 }];
      env.hazards = []; env.bitterPatches = []; env.wind = [2, 1];
    },
    restore: env => { env.light.sky = 1; env.humidity = 0.45; env.obstacles = []; },
  },
  {
    name: 'The Beast',
    line: 'Something has got IN. I did not book this. RUN!',
    look: 'dungeon',
    monster: true,
    apply: env => {
      env.light.sky = 0.4;
      env.food = [{ x: 1.6, y: 1.4, r: 0.3, sugar: 1, bitter: 0, water: 0.3, amount: 6 }];
      env.odors = [{ x: 1.6, y: 1.4, odor: 'vinegar', strength: 1, sigma: 1.2 }];
      env.hazards = []; env.bitterPatches = []; env.wind = [0, 0]; env.obstacles = [];
    },
    restore: env => { env.light.sky = 1; },
  },
];

// Places. Unlike the adventures above, these MOVE the flies: relocate() rebuilds each animal in
// the new world carrying its learned weights, because obstacles are compiled into a fly's physics
// model when it is built and cannot be swapped under a running one.
const PLACES = [
  { key: 'beach',   line: 'To the SEASIDE! Mind the damp. Mind the gulls. There are no gulls.' },
  { key: 'field',   line: 'An open field. Nowhere to hide, and nothing to hide from. Probably.' },
  { key: 'course',  line: 'The OBSTACLE COURSE! Six brains, one gauntlet, no instructions.' },
  { key: 'heaven',  line: 'You have all been very good. Mostly. Welcome to the nice place.' },
  { key: 'hell',    line: 'And now the OTHER place. Do try to keep off the floor.' },
  { key: 'dungeon', line: 'The big top is GONE. Welcome to the dungeon. Mind the flagstones.' },
  { key: 'cavern',  line: 'Down, down, down we go. It is damp. I did warn you. I did not warn you.' },
  { key: 'circus',  line: 'Home again! The sawdust missed you.' },
];
const PLACE_RE = [
  [/\b(beach|sea|seaside|shore|sand|coast)\b/i, 'beach'],
  [/\b(field|meadow|grass|open|outside|outdoors)\b/i, 'field'],
  [/\b(course|gauntlet|obstacle|assault|agility)\b/i, 'course'],
  [/\b(heaven|paradise|clouds?|nice place|afterlife)\b/i, 'heaven'],
  [/\b(hell|inferno|underworld|brimstone|damnation)\b/i, 'hell'],
  [/\b(dungeon|castle|cell|crypt|flagstone)\b/i, 'dungeon'],
  [/\b(cavern|cave|underground|sunken|damp)\b/i, 'cavern'],
  [/\b(circus|big ?top|carnival|home|ring)\b/i, 'circus'],
];

// --- engine ------------------------------------------------------------------------------
// Typed commands. Rule-based on purpose: no API key, no network, no latency, and it cannot
// invent an adventure that the arena has no way to stage.
const COMMANDS = [
  { re: /\b(sugar|food|feast|hunt)\b/i, adventure: 'The Great Sugar Hunt' },
  { re: /\b(bitter|lie|lies|trick|deceiv)/i, adventure: 'The Bitter Truth' },
  { re: /\b(lava|heat|hot|burn|fire)\b/i, adventure: 'The Floor Is Lava' },
  { re: /\b(wind|breeze|storm|gale|weather)\b/i, adventure: 'A Stiff Breeze' },
  { re: /\b(dark|night|lights?\s*(out|down)|blackout)\b/i, adventure: 'Lights Down' },
  { re: /\b(threat|predator|danger|scary|swat|wicked)\b/i, adventure: 'Something Wicked' },
  { re: /\b(dungeon|castle|cell|crypt|stone)\b/i, adventure: 'The Dungeon' },
  { re: /\b(cavern|cave|underground|sunken|damp)\b/i, adventure: 'The Sunken Cavern' },
  { re: /\b(monster|beast|creature|chase|hunter|hunted|maw)\b/i, adventure: 'The Beast' },
];
const CONFUSED = [
  'I have absolutely no idea what that means, and I adore that about you.',
  'Not in the repertoire. Try a scene: sugar, bitter, lava, wind, lights out, threat, monster. Or a place: beach, field, obstacle course, heaven, hell, dungeon, cavern, circus.',
  'A bold suggestion! Sadly the budget says no.',
];

export function startRingmaster(arena, { period = 75000, onLine = null } = {}) {
  const BASE_LOOK = arena.theme || 'circus';   // the look to restore for adventures that don't set one
  const el = document.createElement('div');
  el.id = 'ringmaster';
  el.innerHTML = '<b></b><span></span>';
  document.body.appendChild(el);
  const nameEl = el.querySelector('b'), textEl = el.querySelector('span');

  let last = '', hideAt = 0, lastSpoke = 0, adventure = null, idx = -1;
  const seen = new Map();   // fly id -> last behaviour we reacted to

  function say(text, { priority = 0 } = {}) {
    const now = performance.now();
    if (now - lastSpoke < (priority ? 900 : 4200)) return;   // don't talk over itself
    if (text === last) return;
    last = text; lastSpoke = now; hideAt = now + Math.min(9000, 2600 + text.length * 55);
    nameEl.textContent = 'Janus';
    textEl.textContent = text;
    el.classList.add('on');
    // The orb only materialises when Janus is actually doing something TO the flies -- staging
    // an adventure, reacting to a behaviour, answering a command (priority >= 1). Idle musings
    // still appear in the banner but leave the ring empty, so the orb stays an event rather
    // than scenery, and the flies' visual input stays clean between scenarios.
    if (priority >= 1) arena.janusSpeak?.(hideAt - now + 1400);
    onLine?.(text);
  }

  const flyName = f => f.name || `Fly ${f.id}`;

  function runAdventure(which = null) {
    if (adventure?.restore) adventure.restore(arena.env);
    arena.recallMonster?.();          // never leave a beast loose across a scene change
    if (which) { idx = ADVENTURES.findIndex(a => a.name === which); if (idx < 0) idx = 0; }
    else idx = (idx + 1 + ((Math.random() * (ADVENTURES.length - 1)) | 0)) % ADVENTURES.length;
    adventure = ADVENTURES[idx];
    say(pick(ADVENTURE_CALL), { priority: 2 });
    setTimeout(() => {
      adventure.apply(arena.env);
      // Restaging goes through setLook, which rebuilds the scene AND hands the new reflectances
      // to every fly. An adventure that only repainted our view would be a lie to the flies.
      arena.setLook?.(adventure.look || BASE_LOOK);
      arena.rebuildEnv();
      for (const f of arena.flies) if (f.ready) f.worker.postMessage({ type: 'env', env: arena.env });
      say(adventure.line, { priority: 2 });
      if (adventure.threat && arena.launchThreat) setTimeout(() => arena.launchThreat(), 6000);
      if (adventure.monster && arena.releaseMonster) setTimeout(() => {
        if (arena.releaseMonster()) say('There. In the dark. Do you see it?', { priority: 3 });
      }, 4000);
    }, 2600);
  }

  /**
   * Send everyone somewhere else. The flies are rebuilt in the new world with their learned
   * weights carried across, so this takes a few seconds and must not overlap itself.
   */
  let moving = false;
  async function goTo(key) {
    if (moving) { say('One place at a time!', { priority: 3 }); return false; }
    const place = PLACES.find(p => p.key === key);
    if (!place || !arena.relocate) return false;
    moving = true;
    try {
      arena.recallMonster?.();
      if (adventure?.restore) { adventure.restore(arena.env); adventure = null; }
      say(place.line, { priority: 3 });
      const ok = await arena.relocate(key);
      if (ok) { here = key; say(`${PLACES.find(p => p.key === key).key} it is. Everyone still with us? Marvellous.`, { priority: 1 }); }
      return ok;
    } finally { moving = false; }
  }
  let here = arena.theme || 'circus';

  // React to behaviour transitions on the flies we can see.
  function watch() {
    for (const f of arena.flies) {
      const b = f.last?.behavior;
      if (!b) continue;
      if (seen.get(f.id) === b) continue;
      seen.set(f.id, b);
      const pool = ON_BEHAVIOUR[b];
      if (pool) say(pick(pool).replaceAll('{name}', flyName(f)), { priority: b === 'dead' ? 3 : 1 });
    }
  }

  function idle() {
    if (performance.now() - lastSpoke > 22000) say(pick(IDLE));
  }

  const timers = [
    setInterval(watch, 400),
    setInterval(idle, 6000),
    setInterval(runAdventure, period),
    setInterval(() => { if (hideAt && performance.now() > hideAt) { el.classList.remove('on'); hideAt = 0; } }, 300),
  ];

  setTimeout(() => say(pick(OPENING), { priority: 3 }), 1500);
  setTimeout(runAdventure, 16000);

  /** Parse a typed instruction. Returns the line Janus answered with. */
  function command(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;

    const said = text.match(/^say\s+(.+)/i);
    if (said) { say(said[1], { priority: 3 }); return said[1]; }

    if (/^(next|another|again|go|adventure)\b/i.test(text)) { runAdventure(); return 'next adventure'; }

    if (/\b(calm|clear|reset|stop|peace|quiet)\b/i.test(text)) {
      if (adventure?.restore) adventure.restore(arena.env);
      adventure = null;
      arena.env.hazards = []; arena.env.bitterPatches = []; arena.env.wind = [0, 0];
      arena.env.light.sky = 1;
      arena.env.food = [{ x: 1.0, y: 0.6, r: 0.25, sugar: 1, bitter: 0, water: 0.2, amount: 5 }];
      arena.env.odors = [{ x: 1.0, y: 0.6, odor: 'vinegar', strength: 1, sigma: 0.9 }];
      arena.rebuildEnv();
      for (const f of arena.flies) if (f.ready) f.worker.postMessage({ type: 'env', env: arena.env });
      say('Calm. Boring. Restorative. The arena is reset.', { priority: 3 });
      return 'calm';
    }

    // Places are checked BEFORE adventures: "take them to hell" is a relocation, not a round of
    // The Floor Is Lava, and both would otherwise match on "hell"/"fire" style words.
    for (const [re, key] of PLACE_RE) {
      if (re.test(text)) { goTo(key); return 'place: ' + key; }
    }
    for (const c of COMMANDS) {
      if (c.re.test(text)) { runAdventure(c.adventure); return c.adventure; }
    }
    say(pick(CONFUSED), { priority: 3 });
    return null;
  }

  return {
    goTo, places: PLACES.map(p => p.key), get where() { return here; },
    stop() { timers.forEach(clearInterval); el.remove(); },
    say,
    command,
    next: runAdventure,
    adventures: ADVENTURES.map(a => a.name),
  };
}
