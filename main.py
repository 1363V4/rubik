"""Paint-a-Rubik: Red Dwarf + Datastar + Rocket + three.js (state lives in memory).

    pip install segno            # pure-Python QR encoder, used by /master
    python app.py                # Python 3.11+

Environment:
    PUBLIC_URL=https://paint.example.com   URL encoded in the /master QR code
                                           (default: derived from the request's Host header)
    RELOAD=1                               development auto-reload
"""

import asyncio
import contextlib
import os
import random
from functools import lru_cache
from html import escape

import segno

import rd

# --- Model ---------------------------------------------------------------------------

# letter -> (name, css colour). Keep in sync with COLORS in static/components/rubik-cube.js
PALETTE = {
    "w": ("White", "#f4f4f0"),
    "y": ("Yellow", "#ffd500"),
    "r": ("Red", "#c41e3a"),
    "o": ("Orange", "#ff5800"),
    "g": ("Green", "#009b48"),
    "b": ("Blue", "#0046ad"),
}
SOLVED = {"up": "w", "down": "y", "front": "g", "back": "b", "left": "o", "right": "r"}
CELLS = {
    str(i): i for i in range(9)
}  # path segment -> sticker index (ASCII digits only)
HEARTBEAT = 25  # seconds; re-sends the snapshot so idle proxies keep the stream open


class Room:
    """The one shared cube: 6 faces x 9 stickers, each sticker a palette letter."""

    def __init__(self):
        self.faces = {face: [letter] * 9 for face, letter in SOLVED.items()}
        self.subscribers = set()

    def paint(self, face, index, letter):
        if self.faces[face][index] == letter:
            return
        self.faces[face][index] = letter
        for wake in tuple(self.subscribers):
            # One pending wake-up per stream is enough: streams render the *latest* state.
            with contextlib.suppress(asyncio.QueueFull):
                wake.put_nowait(None)

    @contextlib.asynccontextmanager
    async def subscribe(self):
        wake = asyncio.Queue(maxsize=1)
        self.subscribers.add(wake)
        try:
            yield wake
        finally:
            self.subscribers.discard(wake)


room = Room()


async def wait_for_change(wake):
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(wake.get(), HEARTBEAT)


# --- Views ---------------------------------------------------------------------------

CSS = """
:root{color-scheme:light;--bg:#e8eaf0;--glow:#f8f9fc;--ink:#151821;--mute:#5b6273;--panel:#fff;--line:#d1d5df}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:radial-gradient(110% 80% at 50% 35%,var(--glow) 0%,var(--bg) 70%);color:var(--ink);
  font:16px/1.45 ui-rounded,"SF Pro Rounded","Avenir Next",Nunito,system-ui,"Segoe UI",sans-serif;overflow:hidden}
.stage{position:relative;min-width:0;min-height:0}
rubik-cube{position:absolute;inset:0;display:block}
.play{display:grid;grid-template-rows:minmax(0,1fr) auto;height:100dvh}
.hint{position:absolute;left:0;right:0;top:max(1rem,env(safe-area-inset-top));margin:0;text-align:center;
  color:var(--mute);font-size:.95rem;pointer-events:none}
.bar{display:flex;justify-content:center;padding:.9rem 1rem calc(1rem + env(safe-area-inset-bottom))}
.pill{display:inline-flex;align-items:center;gap:.6rem;padding:.65rem 1.3rem;border-radius:999px;
  background:var(--panel);border:1px solid var(--line);font-size:1.15rem}
.dot{width:1.3rem;height:1.3rem;border-radius:50%;background:var(--c);box-shadow:inset 0 0 0 2px #0002}
.master{display:grid;grid-template-columns:minmax(0,1fr) clamp(300px,34vw,640px);height:100dvh}
.side{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.1rem;padding:2rem;
  text-align:center;background:var(--panel);border-left:1px solid var(--line)}
.side h1{margin:0;font-size:clamp(1.9rem,3.2vw,3.3rem);line-height:1.1;font-weight:800}
.side p{margin:0;color:var(--mute);max-width:26ch}
.qr{width:min(100%,56vh);line-height:0;border:1px solid var(--line);border-radius:1rem;overflow:hidden}
.qr svg{display:block;width:100%;height:auto}
.side .url{max-width:none;font-size:1rem;color:var(--ink);word-break:break-all}
@media (max-width:800px){
  .master{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) auto}
  .side{padding:1rem;border-left:0;border-top:1px solid var(--line)}
  .qr{width:min(55vw,32vh)}
}
"""


def page(title, body_class, body):
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<style>{CSS}</style>
<script type="module" src="/static/datastar-rocket.js"></script>
<script type="module" src="/static/components/rubik-cube.js"></script>
</head>
<body class="{body_class}">
{body}
</body>
</html>"""


def cube_html(display=False):
    """The Rocket host. Its attributes (one 9-letter string per face) are the component's props."""
    attrs = "".join(f' {face}="{"".join(cells)}"' for face, cells in room.faces.items())
    variant = ' variant="display"' if display else ""
    return f'<rubik-cube id="cube"{attrs}{variant}></rubik-cube>'


@lru_cache(maxsize=16)
def qr_svg(url):
    matrix = segno.make_qr(url, error="m").matrix  # rows of 0/1 bytes, no quiet zone
    quiet = 4
    size = len(matrix) + 2 * quiet
    cells = "".join(
        f"M{x + quiet} {y + quiet}h1v1h-1z"
        for y, row in enumerate(matrix)
        for x, dark in enumerate(row)
        if dark
    )
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" '
        f'shape-rendering="crispEdges" role="img" aria-label="QR code">'
        f'<rect width="{size}" height="{size}" fill="#fff"/><path d="{cells}"/></svg>'
    )


def public_url(request):
    if base := os.environ.get("PUBLIC_URL"):
        return base.rstrip("/") + "/"
    proto = request.headers.get("x-forwarded-proto", "http").split(",")[0].strip()
    if proto not in ("http", "https"):
        proto = "http"
    return f"{proto}://{request.headers.get('host', 'localhost')}/"


# --- Pages ---------------------------------------------------------------------------


@rd.get("/")
async def index(request):
    letter = request.cookies.get("color")
    fresh = letter not in PALETTE
    if fresh:
        letter = random.choice(tuple(PALETTE))
    name, css = PALETTE[letter]
    # The paint expression is static and app-authored; `letter` is a validated palette key.
    # The cube only emits `paint` (props down, events up); this wrapper decides what it means.
    body = f"""<main class="stage" id="stage" data-init="@get('/read/cube')"
  data-on:paint="@post('/commands/paint/' + evt.detail.face + '/' + evt.detail.index + '/{letter}')">
  <p class="hint">Drag to turn the cube. Tap a square to paint it.</p>
  <rubik-cube id="cube"></rubik-cube>
</main>
<footer class="bar">
  <div class="pill">Your color: <span class="dot" style="--c:{css}"></span><strong>{name}</strong></div>
</footer>"""
    html = page("Paint the cube", "play", body)
    return rd.html(html, cookies={"color": letter}) if fresh else rd.html(html)


@rd.get("/master")
async def master(request):
    url = public_url(request)
    body = f"""<main class="stage" id="stage" data-init="@get('/read/master', {{openWhenHidden: true}})">
  <rubik-cube id="cube" variant="display"></rubik-cube>
</main>
<aside class="side">
  <h1>Paint the cube</h1>
  <p>Scan with your phone, get a color, and start painting.</p>
  <div class="qr">{qr_svg(url)}</div>
  <p class="url">{escape(url)}</p>
</aside>"""
    return rd.html(page("Rubik master", "master", body))


# --- Read streams (SSE): subscribe first, then send the snapshot, then every change ---


@rd.get("/read/cube")
async def read_cube(request):
    async with room.subscribe() as wake:
        while True:
            yield rd.patch(cube_html())
            await wait_for_change(wake)


@rd.get("/read/master")
async def read_master(request):
    async with room.subscribe() as wake:
        while True:
            yield rd.patch(cube_html(display=True))
            await wait_for_change(wake)


# --- Commands: validate, mutate, publish, return nothing -------------------------------


@rd.post("/commands/paint/<face>/<index>/<color>")
async def paint(request):
    face, index, letter = (request.params[k] for k in ("face", "index", "color"))
    cell = CELLS.get(index)
    # Invalid input is ignored: the stream stays the single source of truth for the UI.
    if face in room.faces and cell is not None and letter in PALETTE:
        room.paint(face, cell, letter)
    return rd.empty()


if __name__ == "__main__":
    # rd.run(reload=os.environ.get("RELOAD") == "1")
    rd.run(sock="/run/legovh/rubik.sock")
