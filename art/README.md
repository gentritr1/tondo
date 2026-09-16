# Art masters

Source art that is **not** served. `public/` is the web root, so anything left in
it is publicly fetchable whether or not the app references it — this directory
exists so a high-resolution master can be kept without shipping it.

- `pizza-table-v2.png` — 1254×1254 master of the photographed pie. The
  web-ready derivative is `public/assets/pizza-table-v2.webp` (1024×1024,
  238KB). These are **not** the same file at different compressions: the master
  is larger in pixels as well as bytes, so deleting it would have lost detail,
  not just weight.

Nothing here is referenced by the app today. See `docs/NEXT-LEVEL.md` for the
art direction decision that governs whether any of it gets wired in.
