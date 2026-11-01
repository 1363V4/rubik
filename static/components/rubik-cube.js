import { rocket } from "/static/datastar-rocket.js";
import * as THREE from "/static/three.module.min.js";

// <rubik-cube up="wwwwwwwww" down="..." front="..." back="..." left="..." right="..." variant="play|display">
// Public props: one 9-letter string per face (row-major, read from outside the face), letters as below.
// Emits a bubbling `paint` event with detail { face, index } when a sticker is tapped.
// variant="display": slowly spins and ignores taps (used on /master).

// Keep in sync with PALETTE in app.py.
const COLORS = {
  w: "#f4f4f0",
  y: "#ffd500",
  r: "#c41e3a",
  o: "#ff5800",
  g: "#009b48",
  b: "#0046ad",
};
const SOLVED = {
  up: "wwwwwwwww",
  down: "yyyyyyyyy",
  front: "ggggggggg",
  back: "bbbbbbbbb",
  left: "ooooooooo",
  right: "rrrrrrrrr",
};
const FACES = Object.keys(SOLVED);
const NORMAL = {
  up: [0, 1, 0],
  down: [0, -1, 0],
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
};
// (row, col) of a sticker as seen from outside its face -> position of its cubie in the 3x3x3 grid.
const CELL = {
  up: (r, c) => [c - 1, 1, r - 1],
  down: (r, c) => [c - 1, -1, 1 - r],
  front: (r, c) => [c - 1, 1 - r, 1],
  back: (r, c) => [1 - c, 1 - r, -1],
  left: (r, c) => [-1, 1 - r, c - 1],
  right: (r, c) => [1, 1 - r, 1 - c],
};

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

function roundedSquare(size, r) {
  const h = size / 2;
  const s = new THREE.Shape();
  s.moveTo(-h + r, -h);
  s.lineTo(h - r, -h);
  s.quadraticCurveTo(h, -h, h, -h + r);
  s.lineTo(h, h - r);
  s.quadraticCurveTo(h, h, h - r, h);
  s.lineTo(-h + r, h);
  s.quadraticCurveTo(-h, h, -h, h - r);
  s.lineTo(-h, -h + r);
  s.quadraticCurveTo(-h, -h, -h + r, -h);
  return new THREE.ShapeGeometry(s, 6);
}

// Builds the WebGL scene inside `stage` (Rocket's `refs.viewport`). `state` holds the current props and is read on every apply().
function createView(host, stage, state) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  const canvas = renderer.domElement;
  canvas.style.cssText =
    "display:block;width:100%;height:100%;cursor:grab;touch-action:none";
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  stage.append(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 1, 200);
  const headlight = new THREE.DirectionalLight(0xffffff, 1.6); // rides with the camera: visible faces stay evenly lit
  headlight.position.set(2, 3, 5);
  camera.add(headlight);
  scene.add(camera, new THREE.AmbientLight(0xffffff, 1.6));

  const mats = Object.fromEntries(
    Object.entries(COLORS).map(([k, c]) => [
      k,
      new THREE.MeshLambertMaterial({ color: c }),
    ]),
  );
  const bodyMat = new THREE.MeshLambertMaterial({ color: "#16181f" });
  const bodyGeo = new THREE.BoxGeometry(1, 1, 1);
  const stickerGeo = roundedSquare(0.86, 0.14);

  const cube = new THREE.Group();
  cube.rotation.set(0.5, -0.7, 0);
  scene.add(cube);

  const pickables = [];
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        if (!x && !y && !z) continue;
        const body = new THREE.Mesh(bodyGeo, bodyMat);
        body.position.set(x, y, z);
        cube.add(body);
        pickables.push(body); // bodies are pickable too, so a sticker is only hit when nothing is in front of it
      }
    }
  }
  const stickers = {};
  for (const face of FACES) {
    const n = new THREE.Vector3(...NORMAL[face]);
    stickers[face] = Array.from({ length: 9 }, (_, i) => {
      const [x, y, z] = CELL[face](Math.floor(i / 3), i % 3);
      const m = new THREE.Mesh(stickerGeo, mats.w);
      m.position.set(x, y, z).addScaledVector(n, 0.504);
      m.quaternion.setFromUnitVectors(Z, n);
      m.userData = { face, index: i };
      cube.add(m);
      pickables.push(m);
      return m;
    });
  }

  let raf = 0,
    last = 0,
    spinning = false,
    drag = null,
    disposed = false;

  const frame = (t) => {
    raf = 0;
    const dt = Math.min(t - last, 50);
    last = t;
    if (spinning && !drag) cube.rotateOnWorldAxis(Y, dt * 0.0004);
    renderer.render(scene, camera);
    if (spinning) request();
  };
  const request = () => {
    if (!raf && !disposed) raf = requestAnimationFrame(frame);
  };

  const fit = () => {
    const w = stage.clientWidth,
      h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Distance at which the cube's bounding sphere (radius 3*sqrt(3)/2 ~ 2.6) fits both fields of view.
    const vHalf = THREE.MathUtils.degToRad(camera.fov / 2);
    const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
    camera.position.set(0, 0, 2.6 / Math.sin(Math.min(vHalf, hHalf)));
    camera.lookAt(0, 0, 0);
    request();
  };
  const resizer = new ResizeObserver(fit);
  resizer.observe(stage);

  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const q = new THREE.Quaternion();

  const pick = (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
    scene.updateMatrixWorld(true);
    ray.setFromCamera(ndc, camera);
    const { face, index } =
      ray.intersectObjects(pickables, false)[0]?.object.userData ?? {};
    if (face) {
      host.dispatchEvent(
        new CustomEvent("paint", {
          bubbles: true,
          composed: true,
          detail: { face, index },
        }),
      );
    }
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || drag) return;
    drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      x0: e.clientX,
      y0: e.clientY,
      moved: false,
    };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (
      !drag.moved &&
      Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 6
    ) {
      drag.moved = true; // past this distance it is a turn, not a tap
      canvas.style.cursor = "grabbing";
    }
    if (drag.moved) {
      cube.quaternion.premultiply(
        q.setFromAxisAngle(Y, (e.clientX - drag.x) * 0.01),
      );
      cube.quaternion.premultiply(
        q.setFromAxisAngle(X, (e.clientY - drag.y) * 0.01),
      );
      request();
    }
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  const endDrag = (e, cancelled) => {
    if (!drag || e.pointerId !== drag.id) return;
    const tap = !drag.moved && !cancelled;
    drag = null;
    canvas.style.cursor = "grab";
    if (tap && state.variant !== "display") pick(e);
    request();
  };
  canvas.addEventListener("pointerup", (e) => endDrag(e, false));
  canvas.addEventListener("pointercancel", (e) => endDrag(e, true));

  const apply = () => {
    for (const face of FACES) {
      const letters = String(state[face]).toLowerCase();
      stickers[face].forEach((m, i) => {
        m.material = mats[letters[i]] ?? mats.w;
      });
    }
    spinning = state.variant === "display";
    request();
  };

  const dispose = () => {
    disposed = true;
    cancelAnimationFrame(raf);
    resizer.disconnect();
    bodyGeo.dispose();
    stickerGeo.dispose();
    bodyMat.dispose();
    Object.values(mats).forEach((m) => m.dispose());
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };

  apply();
  return { apply, dispose };
}

rocket("rubik-cube", {
  manifest: {
    events: [
      {
        name: "paint",
        kind: "custom-event",
        bubbles: true,
        composed: true,
        description:
          "A sticker was tapped. detail: { face: 'up'|'down'|'front'|'back'|'left'|'right', index: 0-8 }",
      },
    ],
  },
  props: ({ string }) => ({
    ...Object.fromEntries(
      FACES.map((face) => [face, string.default(SOLVED[face])]),
    ),
    variant: string.default("play"),
  }),
  renderOnPropChange: false, // the WebGL scene is updated imperatively via observeProps
  render: ({ html }) =>
    html`<div
      data-ref:viewport
      data-ignore-morph
      style="position:absolute;inset:0"
    ></div>`,
  onFirstRender: ({ host, props, refs, observeProps, cleanup }) => {
    const state = { ...SOLVED, variant: "play" };
    const sync = () => {
      for (const k of [...FACES, "variant"])
        if (typeof props[k] === "string") state[k] = props[k];
    };
    sync();
    const view = createView(host, refs.viewport, state);
    observeProps(() => {
      sync(); // `props` is live, as in Rocket's own examples
      view.apply();
    });
    cleanup(view.dispose);
  },
});
