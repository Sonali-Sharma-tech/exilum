// endscreen.js — the run's terminal state. Listens for EV.GAME_WON / EV.GAME_LOST and
// draws a full-screen gothic panel with the run's stats and a restart affordance.
//
// Why this exists: the game had no ending at all. The boss set `bossDefeated` and nothing
// consumed it, so the director's spawn gate re-opened and waves resumed — beating the final
// boss returned you to endless mode. And `killEntity` is generic, so the player could reach
// hp 0 and simply lie on the floor while the run continued around them. Both terminal
// states now exist and both land here.
//
// Same conventions as the rest of the HUD: DOM only, bus-driven, no subsystem imports,
// transform/opacity for animation so it never thrashes layout.
import { bus, EV } from '../core/events.js';
import { el } from './theme.js';

const fmtTime = (s) => {
  const t = Math.max(0, Math.floor(s || 0));
  const m = Math.floor(t / 60);
  return `${m}:${String(t % 60).padStart(2, '0')}`;
};

export class EndScreen {
  constructor(root) {
    this.wrap = el('div', null, root);
    this.wrap.id = 'endscreen';
    this.wrap.style.display = 'none';

    this.panel = el('div', 'es-panel', this.wrap);
    this.kicker = el('div', 'es-kicker', this.panel);
    this.title = el('div', 'es-title', this.panel);
    this.sub = el('div', 'es-sub', this.panel);
    this.stats = el('div', 'es-stats', this.panel);
    this.hint = el('div', 'es-hint', this.panel);
    this.hint.textContent = 'press R to descend again';

    this.shown = false;
    this._offWon = bus.on(EV.GAME_WON, (d) => this.show('won', d));
    this._offLost = bus.on(EV.GAME_LOST, (d) => this.show('lost', d));

    // Restart is a full reload: the world, level generator, director, entity pools and
    // renderer state are all built at boot, and a reload is the honest way to reset every
    // one of them rather than a partial teardown that leaves stale references behind.
    // ARM DELAY. `R` is also Void Beam's skill key, so a player mashing skills at the moment
    // the boss dies would instantly restart the run they just won. Caught in a scripted
    // playthrough: the bot's rotation pressed `r` on the victory frame and reloaded the page
    // before the screen could even be read. 900ms is long enough that the keypress has to be
    // deliberate, short enough that it never feels unresponsive.
    this._armAt = Infinity;
    this._onKey = (e) => {
      if (!this.shown || performance.now() < this._armAt) return;
      if (e.key === 'r' || e.key === 'R' || e.key === 'Enter') location.reload();
    };
    addEventListener('keydown', this._onKey);
  }

  _row(label, value, accent) {
    const r = el('div', 'es-row', this.stats);
    el('span', 'es-k', r).textContent = label;
    const v = el('span', 'es-v', r);
    v.textContent = value;
    if (accent) v.style.color = accent;
  }

  show(kind, d = {}) {
    if (this.shown) return;                     // first terminal state wins
    this.shown = true;
    this._armAt = performance.now() + 900;      // see ARM DELAY in the constructor
    const won = kind === 'won';

    this.wrap.classList.toggle('es-won', won);
    this.wrap.classList.toggle('es-lost', !won);
    this.kicker.textContent = won ? 'the sunder is broken' : 'the dark takes you';
    this.title.textContent = won ? 'VICTORY' : 'YOU DIED';
    this.sub.textContent = won
      ? `${d.bossName || 'the Sunderer'} lies dead on the arena floor.`
      : `slain by ${d.killer || 'the dark'}.`;

    this.stats.textContent = '';
    this._row('Enemies slain', String(d.kills ?? 0), '#e8e2d0');
    this._row('Level reached', String(d.level ?? 1), '#c9a227');
    this._row('Experience', String(Math.floor(d.xp ?? 0)));
    if (won && d.waves != null) this._row('Waves survived', String(d.waves));
    this._row('Time', fmtTime(d.seconds));

    this.wrap.style.display = 'flex';
    // one frame later so the CSS transition actually runs from its start state
    requestAnimationFrame(() => this.wrap.classList.add('es-in'));
  }

  dispose() {
    this._offWon?.(); this._offLost?.();
    removeEventListener('keydown', this._onKey);
  }
}
