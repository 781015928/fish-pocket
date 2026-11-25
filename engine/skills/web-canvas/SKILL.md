---
name: web-canvas
description: Inspect shapes or view the current selection on this conversation's image-generation canvas in the web workbench.
---

Use `canvas_state` to see whether the web workbench has a canvas open for this conversation. When it has a selection, `view_canvas` returns the selection as an image. If it is disconnected, ask the user to open the canvas in the same web conversation. For a canvas selection edit, also load `image-tools`. A picture marked up in the native chat viewer is a normal image attachment; the image-tools skill can edit it directly.
