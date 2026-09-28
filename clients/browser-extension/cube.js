// cube.js — the BigBrain logo mark, as a CSS-3D solid that turns while work
// is in flight. Ported from the design mockup (claude.ai/design project
// c25db7b6, "Browser extension.dc.html"); the geometry below is that file's
// arithmetic, value for value, so the mark on the popup and the mark in the
// mockup are the same object.
//
// The mark is a cube cut into a SLAB (a thin layer) and a BLOCK (the rest)
// along one axis. A move turns the slab a HALF turn — 180° — about that axis.
//
// That half turn is the whole trick behind the stop. A 180° turn always lands
// the cube SOLVED, so `settle()` never has to freeze the mark mid-rotation and
// snap it back: it just marks the run as ending, lets the turn already in
// flight finish its eased landing, and then re-cuts the cube along the next
// axis at 0° — a picture identical to the one just painted, and identical to
// the mark at rest. Sending → sent therefore reads as the mark coming to a
// stop on its own angle, not as an animation being cut off.
//
// The rest angle itself (rotateX(-30deg) rotateY(-45deg)) lives in design.css,
// because it is what the mark looks like when nothing is happening at all.

(function () {
  const TURN = 780; // ms per half turn
  const BLEED = 0.6; // grow every face slightly; hairline seams are visible

  // Six moves, cycled. Each names an axis, that axis' index, and which side
  // of the cube the slab is cut from. `slabCut`/`blockCut` are the two faces
  // the cut exposes — the ones painted as interior rather than surface.
  const MOVES = [
    { axis: "X", k: 0, side: -1 },
    { axis: "Y", k: 1, side: -1 },
    { axis: "Z", k: 2, side: +1 },
    { axis: "Y", k: 1, side: +1 },
    { axis: "X", k: 0, side: +1 },
    { axis: "Y", k: 1, side: -1 },
  ].map((m) => {
    const a = m.axis.toLowerCase();
    return Object.assign(m, {
      slabCut: (m.side < 0 ? "p" : "n") + a,
      blockCut: (m.side < 0 ? "n" : "p") + a,
    });
  });

  const FACES = ["px", "nx", "py", "ny", "pz", "nz"];

  // Surface colours follow the app mark: activity, light top, darker side. Cut faces are
  // ink, so a split reads as a shadow gap rather than a fourth colour.
  const SURFACE = {
    px: "var(--activity)",
    nx: "var(--activity)",
    py: "color-mix(in srgb, var(--fg) 30%, var(--bg))",
    ny: "color-mix(in srgb, var(--fg) 30%, var(--bg))",
    pz: "color-mix(in srgb, var(--fg) 55%, var(--bg))",
    nz: "color-mix(in srgb, var(--fg) 55%, var(--bg))",
  };
  const CUT = "var(--fg)";

  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const reduced = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  function box(stage, name) {
    const el = document.createElement("div");
    el.dataset.box = name;
    for (const key of FACES) {
      const f = document.createElement("div");
      f.dataset.face = key;
      el.appendChild(f);
    }
    stage.appendChild(el);
    return el;
  }

  // Position the six planes of one box: `c` its centre, `h` its half-extents.
  // Faces grow by BLEED so coplanar edges never show a seam — except the cut
  // face, which SHRINKS by twice that, so the interior reads as recessed.
  function place(el, c, h, cutKey) {
    const F = {
      px: [[c[0] + h[0], c[1], c[2]], "rotateY(90deg)", 2 * h[2], 2 * h[1]],
      nx: [[c[0] - h[0], c[1], c[2]], "rotateY(-90deg)", 2 * h[2], 2 * h[1]],
      py: [[c[0], c[1] + h[1], c[2]], "rotateX(-90deg)", 2 * h[0], 2 * h[2]],
      ny: [[c[0], c[1] - h[1], c[2]], "rotateX(90deg)", 2 * h[0], 2 * h[2]],
      pz: [[c[0], c[1], c[2] + h[2]], "", 2 * h[0], 2 * h[1]],
      nz: [[c[0], c[1], c[2] - h[2]], "rotateY(180deg)", 2 * h[0], 2 * h[1]],
    };
    for (const key of FACES) {
      const [p, rot, w0, h0] = F[key];
      const g = key === cutKey ? -2 * BLEED : BLEED;
      const w = w0 + g;
      const hh = h0 + g;
      const face = el.querySelector('[data-face="' + key + '"]');
      face.style.width = w + "px";
      face.style.height = hh + "px";
      face.style.marginLeft = -w / 2 + "px";
      face.style.marginTop = -hh / 2 + "px";
      face.style.transform = "translate3d(" + p[0] + "px," + p[1] + "px," + p[2] + "px) " + rot;
      face.style.background = key === cutKey ? CUT : SURFACE[key];
    }
  }

  // Mount the mark on a `.cube-stage` element carrying data-half (the cube's
  // half-size in px) and data-layer (the slab's thickness). Returns a handle:
  //
  //   spin()        start turning; idempotent while already turning
  //   settle(done)  finish the turn in flight, come to rest, then call done
  //   destroy()     drop the animation frame (page teardown)
  function mount(stage) {
    const H = parseFloat(stage.dataset.half);
    const L = parseFloat(stage.dataset.layer);
    const block = box(stage, "block");
    const slab = box(stage, "slab");

    const nudge = [0, 0];
    let move = MOVES[0];
    let step = 0;
    let raf = 0;
    let fallback = 0;
    let running = false;
    let stopping = false;
    let onRest = null;

    // Re-cut the cube for a move. The slab and block overlap by EPS at the
    // seam so no sliver of background shows through while the slab turns.
    function layout(m) {
      const EPS = Math.max(0.4, H * 0.02);
      const hs = [H, H, H];
      hs[m.k] = L / 2 + EPS / 2;
      const hb = [H, H, H];
      hb[m.k] = H - L / 2 + EPS / 2;
      const cs = [0, 0, 0];
      cs[m.k] = m.side * (H - L / 2 - EPS / 2);
      const cb = [0, 0, 0];
      cb[m.k] = -m.side * (L / 2 - EPS / 2);
      place(slab, cs, hs, m.slabCut);
      place(block, cb, hb, m.blockCut);
    }

    function turn(m, theta) {
      slab.style.transform = "rotate" + m.axis + "(" + theta + "deg)";
      block.style.transform = "";
    }

    // Advance to the next cut and paint it at 0°. Called only at a landing,
    // where the cube is solved — so this repaint is invisible.
    function advance() {
      step = (step + 1) % MOVES.length;
      move = MOVES[step];
      layout(move);
      turn(move, 0);
    }

    // Come to rest and hand back control. Callers hang real behaviour off
    // this — the DISCUSS chip appears here, the popup closes here — so it has
    // to be unconditional. `turn(move, 0)` is a no-op on the normal path,
    // where advance() has already painted the rest pose; it matters only when
    // the fallback below fires, and there the mark is mid-turn in a document
    // nobody is painting anyway.
    function rest() {
      cancelAnimationFrame(raf);
      clearTimeout(fallback);
      raf = 0;
      fallback = 0;
      running = false;
      stopping = false;
      turn(move, 0);
      const done = onRest;
      onRest = null;
      if (done) done();
    }

    // Seat the mark in its slot. The drawn shape is NOT centred on the
    // stage's origin — the rest angle and the perspective see to that — so a
    // slot that centres the stage leaves the mark a few px off wherever you
    // meant to put it, which is exactly the kind of miss you notice against a
    // text edge. Measure the projected box and nudge until the SHAPE is flush
    // with the slot's left edge and centred in its height. Perspective is
    // anchored to the slot, so the projection moves a little when the stage
    // does; two passes converge well inside a pixel.
    //
    // The rest angle stays in CSS (--rest) — this only writes --nudge.
    function align() {
      for (let pass = 0; pass < 2; pass++) {
        const slot = stage.parentElement.getBoundingClientRect();
        if (!slot.width) return; // not laid out yet; nothing to measure
        let L = Infinity;
        let T = Infinity;
        let B = -Infinity;
        for (const f of stage.querySelectorAll("[data-face]")) {
          const r = f.getBoundingClientRect();
          L = Math.min(L, r.left);
          T = Math.min(T, r.top);
          B = Math.max(B, r.bottom);
        }
        if (!Number.isFinite(L)) return;
        nudge[0] += slot.left - L;
        nudge[1] += slot.top + (slot.height - (B - T)) / 2 - T;
        stage.style.setProperty("--nudge", `translate(${nudge[0]}px, ${nudge[1]}px)`);
      }
    }

    layout(move);
    turn(move, 0);
    align();

    return {
      spin() {
        // Reduced motion: the mark stays on its rest angle. Progress is
        // carried by the status line, which says it in words anyway.
        if (running || reduced()) return;
        running = true;
        stopping = false;
        let t0 = null;
        const frame = (now) => {
          if (t0 === null) t0 = now;
          const dt = now - t0;
          if (dt < TURN) {
            turn(move, -180 * ease(dt / TURN));
            raf = requestAnimationFrame(frame);
            return;
          }
          turn(move, -180); // the landing: a half turn is always solved
          advance();
          if (stopping) return rest();
          t0 = now;
          raf = requestAnimationFrame(frame);
        };
        raf = requestAnimationFrame(frame);
      },

      // Ask the mark to stop. It will not stop HERE — it stops at the next
      // landing, which is the only angle the logo is ever drawn at.
      settle(done) {
        if (!running) {
          if (done) done();
          return;
        }
        onRest = done || null;
        stopping = true;
        // A landing is at most one turn away, so if we are past that the
        // frame loop is not running (a throttled or hidden document) and no
        // landing is coming. Rest anyway: whatever the caller wanted to do
        // afterwards is not the animation's to withhold.
        clearTimeout(fallback);
        fallback = setTimeout(rest, TURN + 120);
      },

      destroy() {
        cancelAnimationFrame(raf);
        clearTimeout(fallback);
        running = false;
      },
    };
  }

  globalThis.BigBrainCube = { mount };
})();
