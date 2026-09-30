"""Local X11 computer use; stdout is exclusively MCP JSON-RPC."""
from contextlib import contextmanager, redirect_stdout
import base64
import fcntl
import json
import os
import re
import subprocess
import sys
import time
from typing import Annotated, Literal

if os.getuid() != 1000 or os.geteuid() != 1000:
    raise SystemExit('linux-computer-use must run as dawar (uid 1000).')

# python3-Xlib emits empty-authority warnings to stdout at import time.
with redirect_stdout(sys.stderr):
    import pyautogui as pag
    from mss import MSS
    from mss.tools import to_png
from mcp.server.fastmcp import FastMCP
from mcp.types import ImageContent, TextContent, ToolAnnotations
from pydantic import Field

# Dawar explicitly disabled the corner emergency stop for bot desktops.
# The human desktop server retains its own policy. Exclusive control,
# screenshot freshness, coordinate/window guards and action locks still apply.
pag.FAILSAFE = False
pag.PAUSE = 0.1
mcp = FastMCP('linux-computer-use', instructions='Use screenshot before acting. Coordinates are unscaled X11 pixels. Observe target window, act, then screenshot to verify.', log_level='WARNING')
Coord = Annotated[int, Field(strict=True, ge=0)]
Seconds = Annotated[float, Field(ge=0.1, le=3, allow_inf_nan=False)]
Button = Literal['left', 'middle', 'right']
WindowId = Annotated[str, Field(pattern=r'^0x[0-9a-fA-F]{1,8}$')]
READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)
ACT = ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=True)
last_screenshot = 0.0


def windows():
    result = subprocess.run(['/usr/bin/wmctrl', '-lpG'], capture_output=True, text=True, timeout=3, check=True)
    out = []
    for line in result.stdout.splitlines():
        p = line.split(None, 8)
        if len(p) == 9:
            out.append(dict(id=p[0], desktop=int(p[1]), pid=int(p[2]), x=int(p[3]), y=int(p[4]), width=int(p[5]), height=int(p[6]), title=p[8]))
    return out


def active_window():
    d = pag.platformModule._display
    prop = d.screen().root.get_full_property(d.intern_atom('_NET_ACTIVE_WINDOW'), 0)
    return f'0x{int(prop.value[0]):08x}' if prop is not None and len(prop.value) else None


def point(x, y):
    w, h = screen_size()
    if not (0 <= x < w and 0 <= y < h):
        raise ValueError(f'Point outside controllable screen: 0 <= x < {w}, 0 <= y < {h}. Take a fresh screenshot.')


def screen_size():
    # The X11 connection held by PyAutoGUI can retain geometry from before an
    # RDP resize. MSS opens a fresh connection and reports the current screen.
    with MSS(display=os.environ['DISPLAY']) as sct:
        monitor = sct.monitors[0]
        return monitor['width'], monitor['height']


@contextmanager
def serial():
    # Multiple Codex clients may launch separate stdio server processes.
    with open(os.environ['BOTS_DESKTOP_ACTION_LOCK'], 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Another computer-use call is in progress. Observe a new screenshot before retrying.')
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def ready(window_id=None):
    lease_path = os.environ['BOTS_DESKTOP_CONTROL_LEASE']
    try:
        with open(lease_path) as source:
            lease = json.load(source)
    except FileNotFoundError:
        lease = {}
    if lease.get('expiresAt', 0) > time.time() * 1000:
        raise ValueError('The human is controlling this desktop in DawarTodo. Wait for release, then take a fresh screenshot.')
    if time.monotonic() - last_screenshot > 60:
        raise ValueError('A screenshot from this MCP connection within the last 60 seconds is required before input.')
    if window_id and (active_window() is None or int(window_id, 16) != int(active_window(), 16)):
        raise ValueError('Target window is not active. Screenshot, focus the observed window, and verify before input.')


def done(action):
    return {'ok': True, 'action': action, 'active_window': active_window(), 'verify': 'Take a screenshot and inspect the result.'}


@mcp.tool(annotations=READ)
def screenshot() -> list[TextContent | ImageContent]:
    """Capture the unscaled controllable X11 screen via MSS as PNG image content plus pixel size, active window and window IDs. Origin (0,0) is top-left; x right, y down. Inspect image before input and again afterward."""
    global last_screenshot
    with serial():
        with MSS(display=os.environ['DISPLAY']) as sct:
            monitor = sct.monitors[0]
            shot = sct.grab(monitor)
            png = to_png(shot.rgb, shot.size)
            w, h = shot.size
        metadata = dict(width=w, height=h, origin=[0, 0], scale=1, display=os.environ['DISPLAY'], active_window=active_window(), windows=windows())
        last_screenshot = time.monotonic()
        return [TextContent(type='text', text=json.dumps(metadata)), ImageContent(type='image', data=base64.b64encode(png).decode(), mimeType='image/png')]


@mcp.tool(annotations=ACT)
def click(x: Coord, y: Coord, button: Button = 'left', window_id: WindowId | None = None) -> dict:
    """Click observed absolute screenshot coordinates. Optional window_id guards against typing/clicking in the wrong active window."""
    with serial():
        point(x, y); ready(window_id)
        pag.click(x, y, button=button)
        return done('click')


@mcp.tool(annotations=ACT)
def double_click(x: Coord, y: Coord, button: Button = 'left', window_id: WindowId | None = None) -> dict:
    """Double-click observed absolute screenshot coordinates; 0.15 seconds between clicks."""
    with serial():
        point(x, y); ready(window_id)
        pag.doubleClick(x, y, interval=0.15, button=button)
        return done('double_click')


@mcp.tool(annotations=ACT)
def drag(start_x: Coord, start_y: Coord, end_x: Coord, end_y: Coord, duration: Seconds = 0.5, button: Button = 'left', window_id: WindowId | None = None) -> dict:
    """Drag between observed absolute coordinates, holding button for duration 0.1..3 seconds; always release the button on error."""
    with serial():
        point(start_x, start_y); point(end_x, end_y); ready(window_id)
        pag.moveTo(start_x, start_y)
        try:
            pag.mouseDown(button=button)
            pag.moveTo(end_x, end_y, duration=duration)
        finally:
            # Release only so an abort cannot leave a held button.
            pag.platformModule._mouseUp(*pag.position(), button)
        return done('drag')


@mcp.tool(annotations=ACT)
def scroll(x: Coord, y: Coord, clicks: Annotated[int, Field(strict=True, ge=-20, le=20)], window_id: WindowId | None = None) -> dict:
    """Vertical wheel at observed absolute (x,y). Positive clicks scroll up, negative down; -20..20 nonzero wheel notches, not pixels."""
    if clicks == 0:
        raise ValueError('clicks must be nonzero.')
    with serial():
        point(x, y); ready(window_id)
        pag.scroll(clicks, x=x, y=y)
        return done('scroll')


@mcp.tool(name='type', annotations=ACT)
def type_text(text: Annotated[str, Field(min_length=1, max_length=1000)], interval: Annotated[float, Field(ge=0, le=0.05, allow_inf_nan=False)] = 0.01, window_id: WindowId | None = None) -> dict:
    """Type printable ASCII (1..1000 characters) into the observed focused field using PyAutoGUI. No clipboard. Unicode/control characters are rejected; use keypress for Enter/Tab. Active X11 keyboard layout determines output."""
    if any(ord(c) < 32 or ord(c) > 126 for c in text):
        raise ValueError('Only printable ASCII is supported; use keypress for Enter/Tab. Unicode is not supported.')
    if len(text) * interval > 10:
        raise ValueError('Typing duration exceeds 10 seconds; shorten text or interval.')
    with serial():
        ready(window_id)
        pag.write(text, interval=interval)
        return done('type')


@mcp.tool(annotations=ACT)
def keypress(keys: Annotated[list[str], Field(min_length=1, max_length=5)], window_id: WindowId | None = None) -> dict:
    """Press one key or simultaneous chord, e.g. ['enter'] or ['ctrl','a']. PyAutoGUI lowercase key names; modifiers first, release in reverse order. Separate calls for sequential keys."""
    if any(k not in pag.KEYBOARD_KEYS or not pag.platformModule.keyboardMapping.get(k) for k in keys):
        raise ValueError('Unsupported/unmapped key. Use mapped PyAutoGUI names such as enter, tab, esc, left, ctrl, shift, a.')
    if len(set(keys)) != len(keys):
        raise ValueError('Repeated keys in a chord are not allowed.')
    with serial():
        ready(window_id)
        pressed = []
        try:
            for key in keys:
                pressed.append(key)
                pag.keyDown(key)
        finally:
            for key in reversed(pressed):
                pag.platformModule._keyUp(key)
        return done('keypress')


@mcp.tool(annotations=ACT)
def window_focus(window_id: WindowId) -> dict:
    """Focus an exact hexadecimal window ID observed in screenshot metadata. Uses checked wmctrl argv, verifies _NET_ACTIVE_WINDOW; never fuzzy-matches titles. Screenshot afterward before further input."""
    with serial():
        ready()
        if int(window_id, 16) not in {int(w['id'], 16) for w in windows()}:
            raise ValueError('Window ID no longer exists; take a new screenshot.')
        subprocess.run(['/usr/bin/wmctrl', '-ia', window_id], check=True, capture_output=True, text=True, timeout=3)
        for _ in range(20):
            if active_window() and int(active_window(), 16) == int(window_id, 16):
                return done('window_focus')
            time.sleep(0.05)
        raise ValueError('Window manager did not focus target within one second. Take a screenshot before retrying.')


if __name__ == '__main__':
    mcp.run(transport='stdio')
