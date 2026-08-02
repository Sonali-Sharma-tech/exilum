// Skill slot definitions shared by the skill bar and the mana model.
// Keys mirror player.js: LMB=attack, Q/F/E/R + 1..4 = skills, WASD = movement.
// manaCost / cooldown are HUD-side presentation values (combat stays authoritative).
export const SKILLS = [
  { slot: 'lmb', key: 'lmb', label: 'LMB', name: 'Cleave',        icon: 'slash',  color: '#e8e2d0', mana: 0,   cd: 0    },
  { slot: 'q',   key: 'q',   label: 'Q',   name: 'Firestorm',     icon: 'flame',  color: '#ff7a2e', mana: 28,  cd: 3.2  },
  { slot: 'f',   key: 'f',   label: 'F',   name: 'Frost Nova',    icon: 'nova',   color: '#7fd6ff', mana: 22,  cd: 4.5  },
  { slot: 'e',   key: 'e',   label: 'E',   name: 'Chain Lightning',icon: 'bolt',  color: '#ffe45e', mana: 18,  cd: 0.9  },
  { slot: 'r',   key: 'r',   label: 'R',   name: 'Meteor',        icon: 'meteor', color: '#ff5a2a', mana: 54,  cd: 8.0  },
  { slot: '1',   key: '1',   label: '1',   name: 'Ground Slam',   icon: 'shock',  color: '#d8b071', mana: 14,  cd: 2.4  },
  { slot: '2',   key: '2',   label: '2',   name: 'Toxic Rain',    icon: 'arrow',  color: '#7ec843', mana: 20,  cd: 3.0  },
  { slot: '3',   key: '3',   label: '3',   name: 'Blood Rite',    icon: 'skull',  color: '#e0322b', mana: 40,  cd: 6.0  },
  { slot: '4',   key: '4',   label: '4',   name: 'Sanctuary',     icon: 'rune',   color: '#c9a227', mana: 60,  cd: 12.0 },
];

// Resolve an EV.PLAYER_CAST payload's `skill` to a slot index (name/slot/key/idx).
// Accepts a string, number, or object ({slot|key|name|id|index}).
export function skillIndexFrom(skill) {
  if (skill == null) return -1;
  if (typeof skill === 'object') skill = skill.slot ?? skill.key ?? skill.name ?? skill.id ?? skill.index;
  if (typeof skill === 'number') return skill >= 0 && skill < SKILLS.length ? skill : -1;
  const s = String(skill).toLowerCase();
  // LMB basic-attack aliases
  if (s === 'attack' || s === 'basic' || s === 'melee' || s === 'default' || s === 'primary') return 0;
  return SKILLS.findIndex((d) =>
    d.slot === s || d.key === s || d.name.toLowerCase() === s || d.label.toLowerCase() === s);
}
