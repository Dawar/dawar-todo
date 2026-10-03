"""Capture exact authorized X11 display; stdout contains only PNG bytes."""
import os
import sys
from mss import MSS
from mss.tools import to_png
with MSS(display=os.environ['DISPLAY']) as sct:
    shot = sct.grab(sct.monitors[0])
    sys.stdout.buffer.write(to_png(shot.rgb, shot.size))
